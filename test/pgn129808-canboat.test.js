'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mockApp, start } = require('./helpers');

// Real PGN 129808 traffic — decoded field objects captured off a boat, not
// fixtures written by hand against what the spec looked like it should say.
//
// Source: a YachtDevices YDWG02 gateway, posted by @fakehec on
// sailingnaturali/signalk-dsc#8 (2026-09-02). The calls are public all-ships
// broadcasts from a Spanish coast station (MMSI 002241024), so nothing needed
// redacting. The on-wire YDRAW frames behind the Safety call are in
// canboat/canboatjs#460. (The 2007 receipt dates are GPS week-rollover on the
// capturing receiver, not DSC — kept verbatim rather than tidied.)
//
// Two decoder shapes, both real:
//
//   STOCK_*    what @canboat/canboatjs@3.20.0 emits today. The category decodes
//              off the wire and is then dropped (canboat/canboatjs#460), and
//              field 1 arrives under the *distress* variant's `dscFormat` name.
//   PATCHED_*  the same frames through a build with canboat/canboatjs#461
//              applied, where the category survives.
//
// Both shapes are permanent, so neither set of expectations inverts when #461
// merges: anyone on a pinned canboatjs keeps receiving the stock shape, and
// degrading it to `unknown` is the behaviour we want there, not a defect
// waiting on upstream.
//
// No capture script ships with this file — the hardware isn't ours. Further
// frames come from operators running the plugin; ask on the issue above.

const PATCHED_SAFETY = [
  {
    dscFormat: 'All ships',
    dscCategory: 'Safety',
    dscMessageAddress: '0022410240',
    '1stTelecommand': 'F3E/G3E All modes TP',
    subsequentCommunicationModeOr2ndTelecommand: 'No information',
    proposedRxFrequencyChannel: '900016',
    dscEosSymbol: 127,
    expansionEnabled: 'No',
    timeOfReceipt: '11:03:00',
    dateOfReceipt: '2007.01.11',
    dscEquipmentAssignedMessageId: 0,
  },
  {
    dscFormat: 'All ships',
    dscCategory: 'Safety',
    dscMessageAddress: '0022410240',
    proposedRxFrequencyChannel: '900016',
    timeOfReceipt: '15:13:00',
    dscEquipmentAssignedMessageId: 1,
  },
];

const PATCHED_URGENCY = [
  {
    dscFormat: 'All ships',
    dscCategory: 'Urgency',
    dscMessageAddress: '0022410240',
    '1stTelecommand': 'F3E/G3E All modes TP',
    proposedRxFrequencyChannel: '900016',
    dscEosSymbol: 127,
    timeOfReceipt: '17:47:00',
    dateOfReceipt: '2007.01.15',
    dscEquipmentAssignedMessageId: 0,
  },
  {
    dscFormat: 'All ships',
    dscCategory: 'Urgency',
    dscMessageAddress: '0022410240',
    proposedRxFrequencyChannel: '900016',
    timeOfReceipt: '01:50:00',
    dscEquipmentAssignedMessageId: 1,
  },
];

/** The same frame as stock canboatjs 3.20.0 delivers it: category dropped. */
function asStock(fields) {
  const stock = { ...fields };
  delete stock.dscCategory;
  return stock;
}

function receive(app, fields) {
  app.emit('N2KAnalyzerOut', { pgn: 129808, fields });
}

// Store ids are `<receivedAt>-<mmsi>`, so two calls decoded inside the same
// millisecond collide on the key. Radio traffic never arrives that fast; only
// a test emitting frames back to back does. Let the clock move between them.
const tick = () => new Promise((r) => setTimeout(r, 5));

async function stored(app) {
  return Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
}

test('real SÉCURITÉ off the wire raises a warn notification', async () => {
  const app = mockApp();
  const plugin = start(app);

  receive(app, PATCHED_SAFETY[0]);

  const events = await stored(app);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'safety');
  assert.equal(events[0].format, 'allShips');
  assert.equal(events[0].source, 'n2k');

  const notif = app.deltas[0].delta.updates[0].values[0];
  assert.match(notif.path, /^notifications\.received\.safety\.dsc-/);
  assert.equal(notif.value.state, 'warn');
  plugin.stop();
});

test('real PAN-PAN off the wire raises an alarm notification', async () => {
  const app = mockApp();
  const plugin = start(app);

  receive(app, PATCHED_URGENCY[0]);

  const events = await stored(app);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'urgency');

  const notif = app.deltas[0].delta.updates[0].values[0];
  assert.match(notif.path, /^notifications\.received\.urgency\.dsc-/);
  assert.equal(notif.value.state, 'alarm');
  plugin.stop();
});

// The DSC address is a 40-bit BCD DECIMAL: ten digits, the 9-digit MMSI plus a
// trailing pad. Every real N2K call carries the padded form, so a normalizer
// that only accepts nine digits drops the MMSI on all of them — and with it
// `self`, the EPIRB/PLB beacon lookup, and the identity half of dedupe.
test('the padded 10-digit DSC address resolves to the station MMSI', async () => {
  const app = mockApp();
  const plugin = start(app);

  receive(app, PATCHED_SAFETY[0]);

  const events = await stored(app);
  assert.equal(events[0].mmsi, '002241024');
  plugin.stop();
});

test('a sparse repeat frame parses on the fields it does carry', async () => {
  const app = mockApp();
  const plugin = start(app);

  // Second broadcast of the day, hours later: the gateway delivers far fewer
  // fields. Nothing here should depend on the optional ones being present.
  receive(app, PATCHED_SAFETY[1]);

  const events = await stored(app);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'safety');
  assert.equal(events[0].mmsi, '002241024');
  plugin.stop();
});

test('on stock canboatjs the category is dropped, so the call lands unknown and silent', async () => {
  const app = mockApp();
  const plugin = start(app);

  receive(app, asStock(PATCHED_SAFETY[0]));

  const events = await stored(app);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'unknown');
  assert.equal(events[0].mmsi, '002241024');
  // `unknown` is not in NOTIFICATION_STATES, so nothing sounds. This is the
  // whole cost of canboat/canboatjs#460: a SÉCURITÉ arrives, is logged, and
  // never reaches the crew.
  assert.equal(app.deltas.length, 0);
  plugin.stop();
});

// The sharper edge of the same upstream bug, and the reason it is worth fixing
// rather than documenting: with the category gone, a SÉCURITÉ and a PAN-PAN
// from one station are indistinguishable — same MMSI, both `unknown`, no
// nature — so dedupe folds the second into the first as a repeat. The urgency
// call is not merely silent, it is never separately logged.
test('on stock canboatjs, differing categories from one station collapse into one call', async () => {
  const app = mockApp();
  const plugin = start(app);

  receive(app, asStock(PATCHED_SAFETY[0]));
  await tick();
  receive(app, asStock(PATCHED_URGENCY[0]));

  const events = await stored(app);
  assert.equal(events.length, 1);
  assert.equal(events[0].repeats, 1);

  // With the category intact, the same two frames are two distinct calls.
  const app2 = mockApp();
  const plugin2 = start(app2);
  receive(app2, PATCHED_SAFETY[0]);
  await tick();
  receive(app2, PATCHED_URGENCY[0]);
  assert.equal((await stored(app2)).length, 2);

  plugin.stop();
  plugin2.stop();
});
