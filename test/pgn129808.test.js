'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePgn129808 } = require('../lib/pgn129808');

// Shapes mirror canboatjs output with useCamelCompat (lookups resolved to
// their names, lat/lon in decimal degrees).
test('distress variant (dscDistressCallInformation)', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: {
      dscFormat: 'Distress',
      dscCategory: 'Distress',
      dscMessageAddress: 338040079,
      natureOfDistress: 'Sinking',
      subsequentCommunicationModeOr2ndTelecommand: 'F3E/G3E All modes TP',
      latitudeOfVesselReported: 48.7621,
      longitudeOfVesselReported: -123.2345,
      timeOfPosition: '18:00:00',
      mmsiOfShipInDistress: 338040079,
    },
  });
  assert.equal(ev.format, 'distressAlert');
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '338040079');
  assert.equal(ev.natureOfDistress, 'sinking');
  assert.equal(ev.position.latitude, 48.7621);
  assert.equal(ev.position.longitude, -123.2345);
  assert.equal(ev.utcTime, '18:00');
  assert.equal(ev.distressedMmsi, '338040079');
});

test('nature lookup strings map to the short enum', () => {
  const natures = [
    ['Fire, explosion', 'fire'],
    ['Flooding', 'flooding'],
    ['Collision', 'collision'],
    ['Grounding', 'grounding'],
    ['Listing, in danger of capsizing', 'listing'],
    ['Disabled and adrift', 'adrift'],
    ['Undesignated distress', 'undesignated'],
    ['Abandoning ship', 'abandon'],
    ['Piracy/armed robbery attack', 'piracy'],
    ['Man overboard', 'mob'],
    ['EPIRB emission', 'epirb'],
  ];
  for (const [lookup, short] of natures) {
    const ev = normalizePgn129808({
      pgn: 129808,
      fields: { dscFormat: 'Distress', dscCategory: 'Distress', dscMessageAddress: 1, natureOfDistress: lookup },
    });
    assert.equal(ev.natureOfDistress, short, lookup);
  }
});

test('routine variant (dscCallInformation) with numeric lookups unresolved', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: {
      dscFormatSymbol: 120,
      dscCategorySymbol: 100,
      dscMessageAddress: '003160012',
    },
  });
  assert.equal(ev.format, 'individual');
  assert.equal(ev.category, 'routine');
  assert.equal(ev.mmsi, '003160012'); // leading zeros preserved
  assert.equal(ev.position, undefined);
});

test('urgency category, all-ships format', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: { dscFormat: 'All ships', dscCategory: 'Urgency', dscMessageAddress: 366999707 },
  });
  assert.equal(ev.format, 'allShips');
  assert.equal(ev.category, 'urgency');
});

test('distress relay (all-ships distress) is flagged and keeps casualty + nature', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: {
      dscFormat: 'All ships',
      dscCategory: 'Distress',
      dscMessageAddress: 3160001, // relaying station
      natureOfDistress: 'EPIRB emission',
      latitudeOfVesselReported: 48.79,
      longitudeOfVesselReported: -123.26,
      timeOfPosition: '20:19:00',
      mmsiOfShipInDistress: 316200911, // casualty
    },
  });
  assert.equal(ev.format, 'allShips');
  assert.equal(ev.category, 'distress');
  assert.equal(ev.relay, true);
  assert.equal(ev.natureOfDistress, 'epirb');
  assert.equal(ev.distressedMmsi, '316200911');
});

test('first-party N2K distress alert is not flagged as a relay', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: { dscFormat: 'Distress', dscCategory: 'Distress', dscMessageAddress: 338040079, natureOfDistress: 'Sinking' },
  });
  assert.equal(ev.relay, undefined);
});

test('AIS EPIRB device-beacon MMSI is tagged on the N2K path too', () => {
  const ev = normalizePgn129808({
    pgn: 129808,
    fields: { dscFormat: 'Distress', dscCategory: 'Distress', dscMessageAddress: 974321098, natureOfDistress: 'EPIRB emission' },
  });
  assert.equal(ev.deviceBeacon, 'epirb');
  assert.equal(ev.relay, undefined);
});

test('missing fields produce an unknown-category event, not a throw', () => {
  const ev = normalizePgn129808({ pgn: 129808, fields: {} });
  assert.equal(ev.category, 'unknown');
  assert.equal(ev.mmsi, undefined);
});
