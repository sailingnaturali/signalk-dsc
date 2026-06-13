'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureOwnShip, buildObservations, visibilityToFogScale } = require('../lib/snapshot');

function appWithState(state) {
  return { getSelfPath: (p) => state[p] };
}

test('captures the default fields that have values, nesting wind', () => {
  const app = appWithState({
    'navigation.position': { value: { latitude: 48.76, longitude: -123.05 } },
    'navigation.speedOverGround': 3.1,
    'environment.wind.speedOverGround': { value: 8.2 },
    'environment.wind.directionTrue': 5.5,
    'environment.water.swell.state': 3,
  });
  const snap = captureOwnShip(app);
  assert.deepEqual(snap.position, { latitude: 48.76, longitude: -123.05 });
  assert.equal(snap.sog, 3.1);
  assert.deepEqual(snap.wind, { speed: 8.2, direction: 5.5 });
  assert.equal(snap.seaState, 3);
  assert.equal(snap.cog, undefined); // absent path → absent field, never fabricated
});

test('returns undefined when nothing is available', () => {
  assert.equal(captureOwnShip(appWithState({})), undefined);
});

test('a throwing getSelfPath skips the field, never throws out', () => {
  const app = {
    getSelfPath: (p) => {
      if (p === 'navigation.position') throw new Error('boom');
      if (p === 'navigation.speedOverGround') return 2.0;
      return undefined;
    },
  };
  assert.deepEqual(captureOwnShip(app), { sog: 2.0 });
});

test('extra configured paths are captured; unsafe field names are rejected', () => {
  const app = appWithState({ 'environment.depth.belowTransducer': 12.2 });
  const snap = captureOwnShip(app, [
    { field: 'depth', path: 'environment.depth.belowTransducer' },
    { field: '__proto__.polluted', path: 'environment.depth.belowTransducer' },
    { field: 'constructor', path: 'environment.depth.belowTransducer' },
  ]);
  assert.deepEqual(snap, { depth: 12.2 });
  assert.equal({}.polluted, undefined);
});

test('visibility meters → fog scale table', () => {
  // Fog scale is logarithmic: 0 <50 m … 9 ≥50 km.
  assert.equal(visibilityToFogScale(49), 0);
  assert.equal(visibilityToFogScale(50), 1);
  assert.equal(visibilityToFogScale(1500), 4);
  assert.equal(visibilityToFogScale(25000), 8);
  assert.equal(visibilityToFogScale(80000), 9);
  // A small integer is already a fog-scale code: pass through.
  assert.equal(visibilityToFogScale(7), 7);
  assert.equal(visibilityToFogScale(-1), undefined);
  assert.equal(visibilityToFogScale('fog'), undefined);
});

test('buildObservations takes only valid codes and converts visibility', () => {
  assert.deepEqual(
    buildObservations({ seaState: 3, cloudCoverage: 6, visibility: 1500, sog: 3.1 }),
    { seaState: 3, cloudCoverage: 6, visibility: 4 }
  );
  // Out-of-range codes are dropped, not clamped.
  assert.deepEqual(buildObservations({ seaState: 12, cloudCoverage: 9 }), undefined);
  assert.equal(buildObservations(undefined), undefined);
  assert.equal(buildObservations({ sog: 3.1 }), undefined);
});

test('captured objects are deep copies, and non-serializable values are skipped', () => {
  const position = { latitude: 48.76, longitude: -123.05 };
  const circular = {};
  circular.self = circular;
  const app = {
    getSelfPath: (p) => {
      if (p === 'navigation.position') return position;
      if (p === 'some.circular.path') return circular;
      return undefined;
    },
  };
  const snap = captureOwnShip(app, [{ field: 'weird', path: 'some.circular.path' }]);
  position.latitude = 0; // later mutation of the live model object
  assert.equal(snap.position.latitude, 48.76);
  assert.equal(snap.weird, undefined);
});
