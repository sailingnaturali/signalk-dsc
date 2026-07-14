'use strict';

/*
 * signalk-dsc
 *
 * Receive, log, and alert on DSC (VHF digital selective calling) calls.
 *
 * A DSC-equipped radio that hears traffic on channel 70 re-emits it digitally:
 * as $--DSC/$--DSE sentences on NMEA 0183, or as PGN 129808 on NMEA 2000.
 * SignalK's stock pipeline handles neither well — the 0183 hook drops sparse
 * sentences and persists nothing, and n2k-signalk has no 129808 mapping at all.
 *
 * This plugin listens on both transports and, for every call received:
 *   - appends it to an on-disk JSONL log (forensics: raw input always kept)
 *   - serves the call history at /signalk/v2/api/resources/dsc-calls
 *     (anonymously readable under allow_readonly)
 *   - raises notifications.received.dsc.<category> under *self* — distress → emergency,
 *     urgency → alarm, safety → alert — so the vessel's own alarm chain fires
 *   - optionally writes a GMDSS-style radio-log entry via signalk-logbook
 *
 * Distress alerts repeat every few minutes until acknowledged; repeats inside
 * a 5-minute window update the stored call instead of re-alarming.
 */

const path = require('node:path');

const { parseDsc } = require('./lib/dsc');
const { parseDse, refinePosition } = require('./lib/dse');
const { normalizePgn129808 } = require('./lib/pgn129808');
const {
  EventStore,
  buildMarkerResourceSets,
  buildMessage,
  buildLogbookText,
  captureOwnShip,
  buildObservations,
  createNotifier,
  unwrap,
  writeLogbookEntry,
  createReporter,
  loadOrCreateReceiverKey,
} = require('@sailingnaturali/signalk-distress-core');

const { buildReport } = require('./lib/dscwatch');
const { version } = require('./package.json');

const DSC_PGN = 129808;
const NOTIFICATION_STATES = { distress: 'emergency', urgency: 'alarm', safety: 'alert' };
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DSE_PAIR_WINDOW_MS = 2 * 60 * 1000;
// Notifications are in-memory on the server: a restart silently drops an
// active alarm. On start, re-raise any alert this recent.
const REANNOUNCE_WINDOW_MS = 60 * 60 * 1000;

module.exports = function makePlugin(app) {
  const plugin = {
    id: 'signalk-dsc',
    name: 'DSC call logger',
    description:
      'Receive, log, and alert on DSC (VHF digital selective calling) calls from NMEA 0183 ($CDDSC/$CDDSE) and NMEA 2000 (PGN 129808).',
  };

  plugin.schema = {
    type: 'object',
    properties: {
      maxEvents: {
        type: 'number',
        title: 'Calls to keep',
        description: 'Oldest calls are dropped beyond this count.',
        default: 1000,
      },
      markerWindowHours: {
        type: 'number',
        title: 'Chart marker window (hours)',
        description:
          'Non-distress calls drop off the dsc-call-markers chart layer after this many hours. Active (un-cleared) distress calls always remain.',
        default: 24,
      },
      logbookEnabled: {
        type: 'boolean',
        title: 'Write received calls to the ship\'s log (signalk-logbook)',
        default: true,
      },
      logbookRoutine: {
        type: 'boolean',
        title: 'Also log routine calls',
        description: 'By default only distress/urgency/safety traffic is logged, GMDSS-style.',
        default: false,
      },
      logbookUrl: {
        type: 'string',
        title: 'Logbook API URL',
        default: 'http://localhost:3000/plugins/signalk-logbook/logs',
      },
      logbookToken: {
        type: 'string',
        title: 'SignalK access token for logbook writes',
        description: 'Plugin routes are auth-gated; without a token the logbook write is skipped.',
        default: '',
      },
      snapshotPaths: {
        type: 'array',
        title: 'Extra own-ship paths to snapshot on each call',
        description:
          'Each entry adds a field to the stored event\'s ownShip block (position, course, speed, wind, pressure, sea state, visibility and cloud coverage are always attempted).',
        default: [],
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', title: 'Field name in ownShip' },
            path: { type: 'string', title: 'SignalK self path' },
          },
        },
      },
      dscwatchEnabled: {
        type: 'boolean',
        title: 'Report received calls to DSCWatch.com',
        description:
          'On by default: submit every received DSC call — including your receiver position — to the DSCWatch crowdsourced receiver network. Undelivered reports queue on disk and catch up when connectivity returns. Set to false to keep all data on the boat.',
        default: true,
      },
      dscwatchReceiverKey: {
        type: 'string',
        title: 'DSCWatch receiver key',
        description:
          'Leave blank to use an auto-generated station UUID (persisted in the plugin data directory), or enter this station\'s 9-digit MMSI for attribution.',
        default: '',
      },
      dscwatchUrl: {
        type: 'string',
        title: 'DSCWatch endpoint',
        description: 'Base report URL; the receiver key is appended. Override for testing only.',
        default: 'https://dscwatch.com/api/v1/report',
      },
    },
  };

  let store = null;
  let reporter = null;
  let options = {};
  let started = false;
  let reannounceTimer = null;

  function selfMmsi() {
    const value = unwrap(app.getSelfPath('mmsi'));
    return typeof value === 'string' ? value : undefined;
  }

  function selfPosition() {
    const value = unwrap(app.getSelfPath('navigation.position'));
    return value && typeof value.latitude === 'number' ? value : undefined;
  }

  /** Vessel name from the data model (AIS static data), if we have heard it. */
  function vesselName(mmsi) {
    if (!mmsi || typeof app.getPath !== 'function') return undefined;
    try {
      const value = unwrap(app.getPath(`vessels.urn:mrn:imo:mmsi:${mmsi}.name`));
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  function messageContext(event) {
    return {
      ownPosition: selfPosition(),
      vesselName: vesselName(event.distressedMmsi || event.mmsi),
    };
  }

  // Fire-behind submission to DSCWatch (crowdsourced DSC receiver network).
  // Called before/independent of the store dedupe: the API wants every radio
  // repeat and every DSE refinement as its own POST — the backend dedupes.
  function reportToDscwatch(event, extra) {
    if (!reporter) return;
    reporter.report(buildReport({ ...event, ...extra }, { ownPosition: selfPosition() }));
  }

  // Notification plumbing (raise/clear/reannounce) is shared with
  // signalk-ais-distress via signalk-distress-core. A non-alarming category
  // (routine/unknown, not in NOTIFICATION_STATES) makes raise a no-op.
  const notifier = createNotifier({
    app,
    pluginId: plugin.id,
    pathFor: (event) => `notifications.received.dsc.${event.category}`,
    stateFor: (event) => NOTIFICATION_STATES[event.category],
  });

  // Rebuild the spoken message against the current own-ship position — range
  // and direction shift as we move. Terse on purpose: this string gets spoken;
  // full detail lives in the resource store and the logbook entry.
  function refreshMessage(event) {
    event.message = buildMessage(event, messageContext(event));
    return event;
  }

  function notify(event) {
    refreshMessage(event);
    notifier.raise(event);
  }

  /** Clear an active DSC alarm: drop the live notification from our own source
   *  and stamp the stored events so the restart reannounce skips them. */
  function clearCategory(category) {
    notifier.clear(`notifications.received.dsc.${category}`);
    store.markCleared((e) => e.category === category, new Date().toISOString());
  }

  function shouldLogbook(event) {
    if (options.logbookEnabled === false) return false;
    if (!options.logbookToken) return false;
    if (event.category === 'routine' || event.category === 'unknown') {
      return Boolean(options.logbookRoutine);
    }
    return true;
  }

  async function postLogbook(event) {
    await writeLogbookEntry({
      url: options.logbookUrl,
      token: options.logbookToken,
      text: buildLogbookText(event, messageContext(event)),
      observations: buildObservations(event.ownShip),
      // DSC is received on VHF channel 70 by definition.
      extra: { vhf: '70' },
    });
  }

  /** Store a normalized call, alarm on it, and log it. Returns the stored event. */
  function record(parsed, { source, raw, receivedAt }) {
    const event = {
      receivedAt: receivedAt || new Date().toISOString(),
      source,
      raw,
      ...parsed,
    };
    if (event.mmsi && event.mmsi === selfMmsi()) event.self = true;

    reportToDscwatch(event);

    // Re-transmission of the same call (distress alerts auto-repeat until
    // acknowledged): bump the stored call, do not re-alarm. This matches on
    // mmsi+category+nature and ignores `clearedAt`, so an operator-cleared call
    // that keeps repeating stays silent — a cleared MAYDAY should not re-nag.
    const duplicate = store.findRecent(
      (e) =>
        e.mmsi === event.mmsi &&
        e.category === event.category &&
        e.natureOfDistress === event.natureOfDistress,
      Date.parse(event.receivedAt),
      DEDUPE_WINDOW_MS
    );
    if (duplicate) {
      store.update(duplicate.id, {
        repeats: (duplicate.repeats || 0) + 1,
        lastReceivedAt: event.receivedAt,
      });
      return duplicate;
    }

    // Own-ship context at receive time — the forensic record of the moment
    // the call arrived. First receipt only: repeats keep the original.
    const ownShip = captureOwnShip(app, options.snapshotPaths);
    if (ownShip) event.ownShip = ownShip;

    store.add(event);
    notify(event);
    if (shouldLogbook(event)) {
      postLogbook(event).catch((err) =>
        app.error(`signalk-dsc: logbook write failed: ${err.message}`)
      );
    }
    if (typeof app.setPluginStatus === 'function') {
      app.setPluginStatus(
        `${event.category} call from MMSI ${event.mmsi || 'unknown'} at ${event.receivedAt}`
      );
    }
    return event;
  }

  // The SignalK context the caller's position is emitted under. A distress
  // caller is a vessel in extremis, so it goes under the Search-and-Rescue
  // context (`sar.`) — which chartplotters (e.g. Freeboard-SK) render as a
  // distress/SaR target rather than an ordinary AIS vessel. Every other
  // category stays under `vessels.` like any AIS contact.
  function callerContext(category, mmsi) {
    const prefix = category === 'distress' ? 'sar' : 'vessels';
    return `${prefix}.urn:mrn:imo:mmsi:${mmsi}`;
  }

  // Custom sentence parsers override the stock hooks (a superset of the
  // upstream DSC hook's behavior, plus DSE support it lacks).
  function dscParser(input) {
    if (!started) return null;
    try {
      const parsed = parseDsc(input.parts);
      if (!parsed) return null;
      if (parsed.position) parsed.positionResolution = 'minute';

      const event = record(parsed, {
        source: 'nmea0183',
        raw: input.sentence,
        receivedAt: input.tags && input.tags.timestamp,
      });

      // Delta under the caller's context so chartplotters and AIS-style
      // consumers see the caller's position (distress → SaR target).
      if (parsed.mmsi) {
        const values = [];
        if (parsed.position) {
          values.push({ path: 'navigation.position', value: parsed.position });
        }
        if (parsed.category === 'distress') {
          values.push({
            path: `notifications.${parsed.natureOfDistress}`,
            value: {
              state: 'emergency',
              method: ['visual', 'sound'],
              message: buildMessage(event, messageContext(event)),
            },
          });
        }
        if (values.length) {
          return {
            context: callerContext(parsed.category, parsed.mmsi),
            updates: [{ values }],
          };
        }
      }
    } catch (err) {
      app.error(`signalk-dsc: DSC parse failed: ${err.message}`);
    }
    return null;
  }

  function dseParser(input) {
    if (!started) return null;
    try {
      const ext = parseDse(input.parts);
      if (!ext) return null;
      const now = (input.tags && Date.parse(input.tags.timestamp)) || Date.now();
      const target = store.findRecent(
        (e) => e.mmsi === ext.mmsi && e.position && e.positionResolution === 'minute',
        now,
        DSE_PAIR_WINDOW_MS
      );
      if (!target) return null;

      const refined = refinePosition(target.position, ext);
      store.update(target.id, { position: refined, positionResolution: 'enhanced' });
      reportToDscwatch(target, {
        receivedAt: new Date(now).toISOString(),
        raw: input.sentence,
        positionRefined: true,
      });
      return {
        context: callerContext(target.category, ext.mmsi),
        updates: [{ values: [{ path: 'navigation.position', value: refined }] }],
      };
    } catch (err) {
      app.error(`signalk-dsc: DSE parse failed: ${err.message}`);
    }
    return null;
  }

  function onPgn(pgnData) {
    if (!started || !pgnData || pgnData.pgn !== DSC_PGN) return;
    try {
      record(normalizePgn129808(pgnData), { source: 'n2k', raw: pgnData.fields });
    } catch (err) {
      app.error(`signalk-dsc: PGN 129808 handling failed: ${err.message}`);
    }
  }

  plugin.start = function (opts) {
    options = {
      maxEvents: 1000,
      markerWindowHours: 24,
      logbookEnabled: true,
      logbookRoutine: false,
      logbookUrl: 'http://localhost:3000/plugins/signalk-logbook/logs',
      logbookToken: '',
      dscwatchEnabled: true,
      dscwatchReceiverKey: '',
      dscwatchUrl: 'https://dscwatch.com/api/v1/report',
      ...opts,
    };

    store = new EventStore({
      filePath: path.join(app.getDataDirPath(), 'dsc-calls.jsonl'),
      maxEvents: options.maxEvents,
    });

    if (options.dscwatchEnabled) {
      try {
        const receiverKey =
          options.dscwatchReceiverKey.trim() ||
          loadOrCreateReceiverKey(path.join(app.getDataDirPath(), 'dscwatch-receiver-key'));
        reporter = createReporter({
          url: `${options.dscwatchUrl.replace(/\/+$/, '')}/${receiverKey}`,
          userAgent: `signalk-dsc/${version}`,
          queueFile: path.join(app.getDataDirPath(), 'dscwatch-queue.jsonl'),
          log: (msg) => app.debug(msg),
          onPermanentError: (status) =>
            app.setPluginStatus(`DSCWatch: receiver key rejected (HTTP ${status}) — check configuration`),
        });
        reporter.start();
      } catch (err) {
        app.error(`signalk-dsc: DSCWatch reporting disabled: ${err.message}`);
        reporter = null;
      }
    }

    app.registerResourceProvider({
      type: 'dsc-calls',
      methods: {
        async listResources() {
          const out = {};
          for (const event of store.list()) out[event.id] = event;
          return out;
        },
        async getResource(id) {
          const event = store.get(id);
          if (!event) throw new Error(`No such DSC call: ${id}`);
          return event;
        },
        setResource() {
          throw new Error('dsc-calls is read-only');
        },
        deleteResource() {
          throw new Error('dsc-calls is read-only');
        },
      },
    });

    const buildSets = () =>
      buildMarkerResourceSets(store.list(), {
        now: Date.now(),
        windowHours: options.markerWindowHours,
        nameFor: vesselName,
      });

    app.registerResourceProvider({
      type: 'dsc-call-markers',
      methods: {
        async listResources() {
          return buildSets();
        },
        async getResource(id) {
          const sets = buildSets();
          if (!sets[id]) throw new Error(`No DSC calls in category: ${id}`);
          return sets[id];
        },
        setResource() {
          throw new Error('dsc-call-markers is read-only');
        },
        deleteResource() {
          throw new Error('dsc-call-markers is read-only');
        },
      },
    });

    app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSC', parser: dscParser });
    app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSE', parser: dseParser });
    app.on('N2KAnalyzerOut', onPgn);

    // Let an operator clear an active DSC alarm: a PUT to the notification path
    // drops the live alert and marks the stored call(s) so a restart will not
    // re-raise it. The readwrite device token authorizes this write.
    for (const category of Object.keys(NOTIFICATION_STATES)) {
      // Value ignored: any PUT to these paths means "clear" — no partial-update semantics.
      app.registerPutHandler('vessels.self', `notifications.received.dsc.${category}`, () => {
        clearCategory(category);
        return { state: 'COMPLETED', statusCode: 200 };
      });
    }

    started = true;

    // Survive server restarts mid-incident: re-raise the newest alert per
    // category that is still fresh (a received MAYDAY must not vanish just
    // because the server bounced). Delayed so position providers are up and
    // the refreshed spoken message can say "N miles <direction>" instead of raw
    // coordinates. Non-alarming categories are skipped by raise's no-op path.
    reannounceTimer = setTimeout(() => {
      if (!started) return;
      notifier.reannounce(store.list(), {
        window: REANNOUNCE_WINDOW_MS,
        prepare: refreshMessage,
      });
    }, options.reannounceDelayMs ?? 30000);
  };

  plugin.stop = function () {
    started = false;
    clearTimeout(reannounceTimer);
    app.removeListener('N2KAnalyzerOut', onPgn);
    if (reporter) {
      reporter.stop();
      reporter = null;
    }
  };

  return plugin;
};
