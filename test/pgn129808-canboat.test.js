'use strict';

/*
 * What canboatjs ACTUALLY emits for PGN 129808 — not what we assume it does.
 *
 * The fixtures below are real captures from @canboat/canboatjs 3.20.0
 * (bundling @canboat/ts-pgns 1.11.18), decoded from synthesized frames and
 * verified identical across the actisense, YDRAW and PCDIN input paths. They
 * exist because our hand-written fixtures encoded an assumption that is false
 * on real hardware, and a test built on that assumption passed while the
 * production path was broken.
 *
 * THE UPSTREAM BUG (canboatjs, not the ts-pgns definitions)
 *
 * canboat defines two variants of 129808. The distress variant selects on
 * `dscCategory` as a `Match: 112` field; the general variant has a plain
 * `dscCategorySymbol` LOOKUP in the same slot, same bit offset and length.
 *
 * fromPgn's readPGN picks the match-bearing variant to start decoding with
 * (findMatchPgn), so EVERY 129808 begins against the distress definition —
 * which is why even a routine call comes back carrying `dscFormat`, the
 * distress variant's field Id, rather than `dscFormatSymbol`.
 *
 * At the match field the decoder reads the wire value correctly, then narrows
 * the variant list and does:
 *
 *     value = pgnData.Fields[i].Description      // undefined on the general variant
 *     if (value == null) value = pgnData.Fields[i].Match   // also undefined
 *     if (value !== undefined) this.setField(...)          // never runs
 *
 * So for any category other than 112 the correctly-decoded value is replaced
 * with undefined and the field is silently dropped. Distress survives only
 * because the distress variant carries `Description: 'Distress'`.
 *
 * Consequence for this plugin: distress (alerts AND relays) classifies and
 * alarms correctly, while URGENCY and SAFETY arrive as `unknown` — which has
 * no NOTIFICATION_STATES entry (index.js), so they raise nothing at all.
 * A PAN-PAN or SECURITE received over NMEA 2000 is silent.
 *
 * 129808 is the only PGN in the whole canboat set with this shape (a
 * match-bearing variant plus a non-match sibling carrying a real field at the
 * match position), which is why it has gone unnoticed.
 *
 * WHEN THIS TEST FAILS: upstream has probably been fixed. That is good news —
 * update the fixtures (see scripts/capture-129808.js) and flip the urgency and
 * safety expectations from silent to alarming. No plugin change should be
 * needed; lib/pgn129808.js already maps the category correctly once it is
 * present.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { normalizePgn129808 } = require('../lib/pgn129808');
const makePlugin = require('../index');

// Real canboatjs output. Frames were built by patching the DSC Format and DSC
// Category bytes of a known-good distress frame — both variants share an
// identical 22-field bit layout, so the patched frames are structurally valid.
const CAPTURED = {
  distressAlert: {
    dscFormat: 'Distress',
    dscCategory: 'Distress',
    dscMessageAddress: 338040079,
    natureOfDistress: 'Sinking',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
    mmsiOfShipInDistress: 338040079,
  },
  distressRelay: {
    dscFormat: 'All ships',
    dscCategory: 'Distress',
    dscMessageAddress: 338040079,
    natureOfDistress: 'Sinking',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
    mmsiOfShipInDistress: 338040079,
  },
  // Note what is NOT here: no category key of any spelling. The wire byte was
  // a valid DSC_CATEGORY value (110 urgency / 108 safety / 100 routine).
  urgency: {
    dscFormat: 'All ships',
    dscMessageAddress: 338040079,
    '1stTelecommand': 'End of call',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
  },
  safety: {
    dscFormat: 'All ships',
    dscMessageAddress: 338040079,
    '1stTelecommand': 'End of call',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
  },
  routine: {
    dscFormat: 'Individual stations',
    dscMessageAddress: 338040079,
    '1stTelecommand': 'End of call',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
  },
};

test('no non-distress capture carries a category field, under any spelling', () => {
  for (const label of ['urgency', 'safety', 'routine']) {
    const keys = Object.keys(CAPTURED[label]).filter((k) => /categ/i.test(k));
    assert.deepEqual(keys, [], `${label} unexpectedly carried ${keys.join(', ')}`);
  }
  // The distress pair is the only place a category survives the decoder.
  assert.equal(CAPTURED.distressAlert.dscCategory, 'Distress');
  assert.equal(CAPTURED.distressRelay.dscCategory, 'Distress');
});

test('category matrix through normalizePgn129808 matches real decoder output', () => {
  const expected = {
    distressAlert: { category: 'distress', format: 'distressAlert' },
    distressRelay: { category: 'distress', format: 'allShips' },
    urgency: { category: 'unknown', format: 'allShips' }, // upstream bug
    safety: { category: 'unknown', format: 'allShips' }, // upstream bug
    routine: { category: 'unknown', format: 'individual' }, // upstream bug
  };
  for (const [label, want] of Object.entries(expected)) {
    const ev = normalizePgn129808({ pgn: 129808, fields: CAPTURED[label] });
    assert.equal(ev.category, want.category, `${label} category`);
    assert.equal(ev.format, want.format, `${label} format`);
  }
});

test('a distress relay is flagged as a relay, not a first-party alert', () => {
  assert.equal(normalizePgn129808({ pgn: 129808, fields: CAPTURED.distressRelay }).relay, true);
  assert.equal(normalizePgn129808({ pgn: 129808, fields: CAPTURED.distressAlert }).relay, undefined);
});

function mockApp() {
  const app = new EventEmitter();
  app.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-canboat-'));
  app.getDataDirPath = () => app.dataDir;
  app.getSelfPath = (p) => (p === 'mmsi' ? '368000001' : undefined);
  app.deltas = [];
  app.handleMessage = (id, delta) => app.deltas.push({ id, delta });
  app.emitPropertyValue = () => {};
  app.registerResourceProvider = () => {};
  app.registerPutHandler = () => {};
  app.error = () => {};
  app.debug = () => {};
  app.setPluginStatus = () => {};
  return app;
}

function notificationsFor(fields) {
  const app = mockApp();
  const plugin = makePlugin(app);
  plugin.start({ logbookToken: '', dscwatchEnabled: false });
  app.emit('N2KAnalyzerOut', { pgn: 129808, fields });
  plugin.stop();
  return app.deltas.flatMap((d) =>
    d.delta.updates.flatMap((u) =>
      (u.values || []).filter((v) => String(v.path).startsWith('notifications.'))
    )
  );
}

// The consequence that actually matters, asserted end-to-end through the
// plugin rather than inferred from the category mapping.
test('END TO END: distress alerts and relays alarm over N2K', () => {
  for (const label of ['distressAlert', 'distressRelay']) {
    const notifs = notificationsFor(CAPTURED[label]);
    assert.ok(notifs.length > 0, `${label} raised no notification`);
    assert.ok(
      notifs.some((n) => n.value && n.value.state === 'emergency'),
      `${label} did not reach emergency state`
    );
  }
});

test('END TO END: urgency and safety are SILENT over N2K (upstream bug)', () => {
  // Documents the defect, not the intent. When canboatjs is fixed this test
  // fails and should be inverted — see the header.
  for (const label of ['urgency', 'safety']) {
    assert.deepEqual(
      notificationsFor(CAPTURED[label]),
      [],
      `${label} now raises a notification — has canboatjs been fixed? See the file header.`
    );
  }
});

test('END TO END: routine is silent, which is correct regardless of the bug', () => {
  assert.deepEqual(notificationsFor(CAPTURED.routine), []);
});

// Opt-in live check: re-derives the fixtures from whatever canboatjs is
// installed, so a version bump that changes this behaviour is caught. Skipped
// when canboatjs is absent — it carries native bindings and 100+ transitive
// deps, and this plugin ships with no devDependencies so the SignalK
// cross-platform CI matrix (armv7 / Venus OS included) stays installable.
let canboat = null;
try {
  canboat = require('@canboat/canboatjs');
} catch {
  canboat = null;
}

test(
  'LIVE: installed canboatjs still drops the category on non-distress calls',
  { skip: canboat ? false : 'npm i -D @canboat/canboatjs to run this check' },
  () => {
    const base = canboat.pgnToActisenseSerialFormat({
      pgn: 129808,
      dst: 255,
      src: 3,
      prio: 3,
      fields: {
        dscFormat: 'Distress',
        dscCategory: 'Distress',
        dscMessageAddress: '338040079',
        natureOfDistress: 'Sinking',
        latitudeOfVesselReported: 48.7621,
        longitudeOfVesselReported: -123.2345,
        timeOfPosition: '18:00:00',
        mmsiOfShipInDistress: '338040079',
      },
    });
    const parts = base.split(',');
    const HDR = 6; // timestamp,prio,pgn,src,dst,len then data
    const hex = (n) => n.toString(16).padStart(2, '0');
    const decode = (fmt, cat) => {
      const p = parts.slice();
      p[HDR] = hex(fmt);
      p[HDR + 1] = hex(cat);
      return new canboat.FromPgn({ useCamelCompat: true }).parseString(p.join(','));
    };

    // 112 distress survives; 100/108/110 do not.
    for (const [cat, present] of [[112, true], [110, false], [108, false], [100, false]]) {
      const out = decode(116, cat);
      const key = Object.keys(out.fields).find((k) => /categ/i.test(k));
      assert.equal(
        Boolean(key),
        present,
        `category byte ${cat}: expected ${present ? 'present' : 'dropped'}, got ${key || 'none'}`
      );
    }
  }
);
