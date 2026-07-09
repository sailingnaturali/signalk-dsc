'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReport } = require('../lib/dscwatch');

// Golden test: the DSCWatch spec's distress-alert example, from an event
// shaped exactly as record() stores it (plus local-only fields that must
// never leak off the boat).
test('distress alert maps to the DSCWatch example body', () => {
  const event = {
    id: '2026-06-30T14:23:07.812Z-244223600',           // local-only
    message: 'Mayday relay…',                            // local-only
    repeats: 2,                                          // local-only
    ownShip: { position: { latitude: 48.4, longitude: 3.1 }, sog: 3.2 }, // local-only
    receivedAt: '2026-06-30T14:23:07.812Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.7833, longitude: 3.45 },
    positionResolution: 'minute',
    utcTime: '14:23',
    expansion: true,
    raw: '$CDDSC,12,2442236000,12,05,00,0484700327,1423,,,,E*5A',
  };
  const body = buildReport(event, { ownPosition: { latitude: 48.4, longitude: 3.1 } });
  assert.deepEqual(body, {
    receivedAt: '2026-06-30T14:23:07.812Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.7833, longitude: 3.45 },
    positionResolution: 'minute',
    utcTime: '14:23',
    expansion: true,
    ownPosition: { latitude: 48.4, longitude: 3.1 },
    raw: '$CDDSC,12,2442236000,12,05,00,0484700327,1423,,,,E*5A',
  });
});

// Golden test: the spec's DSE refinement example.
test('DSE refinement maps to the DSCWatch refinement body', () => {
  const event = {
    receivedAt: '2026-06-30T14:23:11.004Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.78411, longitude: 3.45219 },
    positionResolution: 'enhanced',
    positionRefined: true,
    expansion: true, // from the original call — flag rides along, fine
    raw: '$CDDSE,1,1,A,2442236000,00,4807.846,00320.131*4F',
  };
  const body = buildReport(event, {});
  assert.equal(body.positionRefined, true);
  assert.equal(body.positionResolution, 'enhanced');
  assert.equal(body.raw, '$CDDSE,1,1,A,2442236000,00,4807.846,00320.131*4F');
  assert.equal('ownPosition' in body, false); // no GPS fix → omitted
});

test('boolean flags appear only when true; absent fields are omitted', () => {
  const body = buildReport({
    receivedAt: 't', source: 'nmea0183', category: 'routine', format: 'individual',
    raw: '$CDDSC,…', mmsi: '338158137', workingChannel: '72',
    expansion: false, // parseDsc always sets it; false must not be sent
  });
  assert.equal('expansion' in body, false);
  assert.equal('self' in body, false);
  assert.equal('relay' in body, false);
  assert.equal('position' in body, false);
  assert.equal(body.workingChannel, '72');
});

test('n2k events keep the PGN fields object as raw and default format', () => {
  const body = buildReport({
    receivedAt: 't', source: 'n2k', category: 'urgency',
    raw: { dscFormat: 'All ships', dscCategory: 'Urgency' },
  });
  assert.deepEqual(body.raw, { dscFormat: 'All ships', dscCategory: 'Urgency' });
  assert.equal(body.format, 'unknown'); // required by the API; never absent
});
