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
 *   - raises notifications.dsc.<category> under *self* — distress → emergency,
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
const { EventStore } = require('./lib/store');
const { buildMessage, buildLogbookText } = require('./lib/format');

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
    },
  };

  let store = null;
  let options = {};
  let started = false;
  let reannounceTimer = null;

  function unwrap(node) {
    return node && typeof node === 'object' && 'value' in node ? node.value : node;
  }

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

  function notify(event) {
    const state = NOTIFICATION_STATES[event.category];
    if (!state) return;
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: `notifications.dsc.${event.category}`,
              value: {
                state,
                method: ['visual', 'sound'],
                // Kept terse on purpose: this string gets spoken by the
                // voice pipeline. Full detail lives in the resource store
                // and the logbook entry.
                message: buildMessage(event, messageContext(event)),
                timestamp: event.receivedAt,
              },
            },
          ],
        },
      ],
    });
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
    const res = await fetch(options.logbookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // signalk-server's auth gate reads the Authorization header; the
        // logbook plugin reads the author from the JAUTHENTICATION cookie.
        Authorization: `Bearer ${options.logbookToken}`,
        Cookie: `JAUTHENTICATION=${options.logbookToken}`,
      },
      body: JSON.stringify({ text: buildLogbookText(event, messageContext(event)), ago: 0 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    // Re-transmission of the same call (distress alerts auto-repeat until
    // acknowledged): bump the stored call, do not re-alarm.
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

  function remoteContext(mmsi) {
    return `vessels.urn:mrn:imo:mmsi:${mmsi}`;
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

      // Upstream-compatible delta under the sender's context so chartplotters
      // and AIS-style consumers see the caller's position.
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
          return { context: remoteContext(parsed.mmsi), updates: [{ values }] };
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
      return {
        context: remoteContext(ext.mmsi),
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
      logbookEnabled: true,
      logbookRoutine: false,
      logbookUrl: 'http://localhost:3000/plugins/signalk-logbook/logs',
      logbookToken: '',
      ...opts,
    };

    store = new EventStore({
      filePath: path.join(app.getDataDirPath(), 'dsc-calls.jsonl'),
      maxEvents: options.maxEvents,
    });

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

    app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSC', parser: dscParser });
    app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSE', parser: dseParser });
    app.on('N2KAnalyzerOut', onPgn);

    started = true;

    // Survive server restarts mid-incident: re-raise the newest alert per
    // category that is still fresh (a received MAYDAY must not vanish just
    // because the server bounced). Delayed so position providers are up and
    // the spoken message can say "N miles <direction>" instead of raw
    // coordinates.
    reannounceTimer = setTimeout(() => {
      if (!started) return;
      const now = Date.now();
      const reannounced = new Set();
      const events = store.list();
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (!NOTIFICATION_STATES[event.category] || reannounced.has(event.category)) continue;
        const at = Date.parse(event.lastReceivedAt || event.receivedAt);
        if (now - at <= REANNOUNCE_WINDOW_MS) {
          notify(event);
          reannounced.add(event.category);
        }
      }
    }, options.reannounceDelayMs ?? 30000);
  };

  plugin.stop = function () {
    started = false;
    clearTimeout(reannounceTimer);
    app.removeListener('N2KAnalyzerOut', onPgn);
  };

  return plugin;
};
