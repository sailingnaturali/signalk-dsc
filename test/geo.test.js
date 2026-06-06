'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distanceNm, bearingDegrees, compassWord } = require('../lib/geo');

const HERE = { latitude: 48.7621, longitude: -123.2345 }; // Boundary Pass

test('one degree of latitude is sixty nautical miles', () => {
  const north = { latitude: HERE.latitude + 1, longitude: HERE.longitude };
  assert.ok(Math.abs(distanceNm(HERE, north) - 60) < 0.2);
});

test('bearing to a target due east is ~090', () => {
  const east = { latitude: HERE.latitude, longitude: HERE.longitude + 0.1 };
  assert.ok(Math.abs(bearingDegrees(HERE, east) - 90) < 1);
});

test('bearing to a target to the northwest is ~315', () => {
  // At this latitude 1' lon ≈ 0.66' lat in distance; compensate to get a true 45°.
  const nw = {
    latitude: HERE.latitude + 0.1,
    longitude: HERE.longitude - 0.1 / Math.cos((HERE.latitude * Math.PI) / 180),
  };
  assert.ok(Math.abs(bearingDegrees(HERE, nw) - 315) < 1);
});

test('compassWord maps bearings to eight voice-friendly words', () => {
  assert.equal(compassWord(0), 'north');
  assert.equal(compassWord(359), 'north');
  assert.equal(compassWord(45), 'northeast');
  assert.equal(compassWord(90), 'east');
  assert.equal(compassWord(135), 'southeast');
  assert.equal(compassWord(180), 'south');
  assert.equal(compassWord(225), 'southwest');
  assert.equal(compassWord(270), 'west');
  assert.equal(compassWord(315), 'northwest');
});
