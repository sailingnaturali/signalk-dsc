'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMarkerResourceSets } = require('../lib/markers');

const NOW = Date.parse('2026-06-21T20:00:00Z');

function evt(over = {}) {
  return {
    category: 'distress',
    natureOfDistress: 'fire',
    mmsi: '316200911',
    position: { latitude: 48.9, longitude: -123.23 },
    utcTime: '03:37',
    receivedAt: '2026-06-21T19:50:00Z',
    ...over,
  };
}

test('groups calls into per-category ResourceSets with FeatureCollection values', () => {
  const sets = buildMarkerResourceSets(
    [evt(), evt({ category: 'routine', natureOfDistress: undefined, mmsi: '338158137' })],
    { now: NOW, windowHours: 24, nameFor: () => undefined }
  );
  assert.deepEqual(Object.keys(sets).sort(), ['distress', 'routine']);
  assert.equal(sets.distress.values.type, 'FeatureCollection');
  assert.equal(sets.distress.values.features.length, 1);
});

test('each feature is a GeoJSON Point with [lon, lat] order', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24 });
  const f = sets.distress.values.features[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [-123.23, 48.9]);
});

test('feature properties carry nature, category, mmsi, times, and vesselName', () => {
  const sets = buildMarkerResourceSets([evt()], {
    now: NOW,
    windowHours: 24,
    nameFor: (mmsi) => (mmsi === '316200911' ? 'Wind Chaser' : undefined),
  });
  const p = sets.distress.values.features[0].properties;
  assert.equal(p.name, 'distress: fire');
  assert.equal(p.category, 'distress');
  assert.equal(p.natureOfDistress, 'fire');
  assert.equal(p.mmsi, '316200911');
  assert.equal(p.utcTime, '03:37');
  assert.equal(p.receivedAt, '2026-06-21T19:50:00Z');
  assert.equal(p.vesselName, 'Wind Chaser');
});

test('vesselName property is omitted when not resolvable', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24, nameFor: () => undefined });
  assert.equal('vesselName' in sets.distress.values.features[0].properties, false);
});

test('calls without a position are skipped', () => {
  const sets = buildMarkerResourceSets([evt({ position: undefined })], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('per-category default style carries the category colour', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24 });
  assert.equal(sets.distress.styles.default.stroke, 'rgba(211,47,47,1)');
});

test('calls with an incomplete position (missing longitude) are skipped', () => {
  const sets = buildMarkerResourceSets([evt({ position: { latitude: 48.9 } })], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('unknown-category calls get their own set with the routine fallback colour', () => {
  const sets = buildMarkerResourceSets(
    [evt({ category: 'unknown', natureOfDistress: undefined })],
    { now: NOW, windowHours: 24 }
  );
  assert.ok(sets.unknown);
  assert.equal(sets.unknown.values.features.length, 1);
  assert.equal(sets.unknown.styles.default.stroke, 'rgba(117,117,117,1)');
});

test('non-distress older than the window is excluded', () => {
  const old = evt({ category: 'routine', natureOfDistress: undefined, receivedAt: '2026-06-20T10:00:00Z' });
  const sets = buildMarkerResourceSets([old], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('non-distress within the window is included', () => {
  const recent = evt({ category: 'routine', natureOfDistress: undefined, receivedAt: '2026-06-21T10:00:00Z' });
  const sets = buildMarkerResourceSets([recent], { now: NOW, windowHours: 24 });
  assert.equal(sets.routine.values.features.length, 1);
});

test('un-cleared distress older than the window is still shown', () => {
  const oldDistress = evt({ receivedAt: '2026-06-19T10:00:00Z' });
  const sets = buildMarkerResourceSets([oldDistress], { now: NOW, windowHours: 24 });
  assert.equal(sets.distress.values.features.length, 1);
});

test('cleared distress is excluded once outside the window', () => {
  const clearedOld = evt({ receivedAt: '2026-06-19T10:00:00Z', clearedAt: '2026-06-19T10:05:00Z' });
  const sets = buildMarkerResourceSets([clearedOld], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('non-distress exactly at the window edge is included', () => {
  const edge = evt({
    category: 'routine',
    natureOfDistress: undefined,
    receivedAt: '2026-06-20T20:00:00Z', // exactly 24h before NOW
  });
  const sets = buildMarkerResourceSets([edge], { now: NOW, windowHours: 24 });
  assert.equal(sets.routine.values.features.length, 1);
});
