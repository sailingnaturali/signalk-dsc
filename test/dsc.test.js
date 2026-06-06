'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDsc, parsePosition, parseMmsi } = require('../lib/dsc');

// Split a sentence body into the parts array the SignalK parser hands to hooks
// (fields after the sentence id, checksum stripped).
function parts(sentence) {
  return sentence.split('*')[0].split(',').slice(1);
}

test('distress alert (documented example, sinking off Detroit)', () => {
  // From the upstream DSC hook docs / continuouswave DSC datagram reference.
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ev.format, 'distressAlert');
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '338040079');
  assert.equal(ev.natureOfDistress, 'adrift'); // 06 = disabled and adrift
  assert.ok(ev.position);
  // 1423108312 → quadrant 1 (NW): 42°31'N 083°12'W
  assert.ok(Math.abs(ev.position.latitude - (42 + 31 / 60)) < 1e-9);
  assert.ok(Math.abs(ev.position.longitude - -(83 + 12 / 60)) < 1e-9);
  assert.equal(ev.utcTime, '20:19');
  assert.equal(ev.distressedMmsi, undefined);
});

test('sparse distress alert with omitted category (nmea0183-signalk#217)', () => {
  // Some radios omit the category field on distress alerts (it is implied by
  // format 112). This exact sentence is the unparseable one from issue #217.
  const ev = parseDsc(parts('$CDDSC,12,5031105200,,05,00,2380814428,1800,,,R,E*6C'));
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '503110520');
  assert.equal(ev.natureOfDistress, 'sinking');
  // 2380814428 → quadrant 2 (SE): 38°08'S 144°28'E (Geelong AUS)
  assert.ok(Math.abs(ev.position.latitude - -(38 + 8 / 60)) < 1e-9);
  assert.ok(Math.abs(ev.position.longitude - (144 + 28 / 60)) < 1e-9);
  assert.equal(ev.utcTime, '18:00');
});

test('distress cancellation carries the cancelling vessel MMSI', () => {
  const ev = parseDsc(parts('$CDDSC,12,3381581370,12,06,00,1423108312,0236,3381581370,,S,*20'));
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '338158137');
  assert.equal(ev.distressedMmsi, '338158137');
});

test('routine individual call with ship position telecommand', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B'));
  assert.equal(ev.format, 'individual');
  assert.equal(ev.category, 'routine');
  assert.equal(ev.mmsi, '338158137');
  assert.equal(ev.natureOfDistress, undefined);
  assert.ok(ev.position); // telecommand 21 = ship position
  assert.equal(ev.utcTime, '19:02');
});

test('routine call without position telecommand has no position', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,09,26,1423108312,1902,,,B,E*00'));
  assert.equal(ev.position, undefined);
});

test('unusable input returns null', () => {
  assert.equal(parseDsc([]), null);
  assert.equal(parseDsc(['12']), null);
});

test('parsePosition rejects the no-position sentinel and junk', () => {
  assert.equal(parsePosition('9999999999'), undefined);
  assert.equal(parsePosition(''), undefined);
  assert.equal(parsePosition('4'), undefined);
  assert.equal(parsePosition(undefined), undefined);
});

test('parseMmsi strips the trailing zero from 10-digit fields', () => {
  assert.equal(parseMmsi('3380400790'), '338040079');
  assert.equal(parseMmsi('338040079'), '338040079');
  assert.equal(parseMmsi(''), undefined);
  assert.equal(parseMmsi('notanmmsi'), undefined);
});

test('time sentinel 8888 means unavailable', () => {
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,8888,,,S,E*00'));
  assert.equal(ev.utcTime, undefined);
});
