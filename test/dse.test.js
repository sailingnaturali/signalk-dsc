'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDse, refinePosition } = require('../lib/dse');

function parts(sentence) {
  return sentence.split('*')[0].split(',').slice(1);
}

test('DSE position extension (documented example)', () => {
  const ext = parseDse(parts('$CDDSE,1,1,A,3380400790,00,45894494*1B'));
  assert.equal(ext.mmsi, '338040079');
  assert.ok(Math.abs(ext.latMinuteFraction - 0.4589) < 1e-9);
  assert.ok(Math.abs(ext.lonMinuteFraction - 0.4494) < 1e-9);
});

test('multi-sentence DSE groups are not supported', () => {
  assert.equal(parseDse(parts('$CDDSE,2,1,A,3380400790,00,45894494*18')), null);
});

test('DSE without a position extension code returns null', () => {
  assert.equal(parseDse(parts('$CDDSE,1,1,A,3380400790,01,12345678*1A')), null);
});

test('refinePosition extends a DSC position away from zero', () => {
  // DSC truncates the position toward zero; the DSE fraction extends outward.
  const ne = refinePosition(
    { latitude: 42 + 31 / 60, longitude: 83 + 12 / 60 },
    { latMinuteFraction: 0.4589, lonMinuteFraction: 0.4494 }
  );
  assert.ok(Math.abs(ne.latitude - (42 + 31.4589 / 60)) < 1e-9);
  assert.ok(Math.abs(ne.longitude - (83 + 12.4494 / 60)) < 1e-9);

  const sw = refinePosition(
    { latitude: -(38 + 8 / 60), longitude: -(144 + 28 / 60) },
    { latMinuteFraction: 0.25, lonMinuteFraction: 0.5 }
  );
  assert.ok(Math.abs(sw.latitude - -(38 + 8.25 / 60)) < 1e-9);
  assert.ok(Math.abs(sw.longitude - -(144 + 28.5 / 60)) < 1e-9);
});
