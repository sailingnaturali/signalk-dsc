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

test('unrecognised numeric nature code is preserved as code-NN', () => {
  // A well-formed but unlisted 2-digit nature code stays informative.
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,11,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ev.natureOfDistress, 'code-11');
});

test('malformed nature field never yields a dotted/unsafe token', () => {
  // The nature field arrives over the air and is unsanitised. A hostile or
  // garbled value must not flow into a notification path segment (it would
  // hit the unguarded path walk in SignalK/signalk-server#2768). Anything
  // that is not a clean numeric code collapses to a safe constant.
  for (const hostile of ['__proto__', 'a.b.c', 'constructor', '..', 'x/y']) {
    const ev = parseDsc(
      parts(`$CDDSC,12,3380400790,12,${hostile},00,1423108312,2019,,,S,E*6A`)
    );
    assert.equal(
      ev.natureOfDistress,
      'undesignated',
      `nature "${hostile}" should collapse to a safe token`
    );
    assert.doesNotMatch(ev.natureOfDistress, /[.\\/]/);
  }
});

test('distress cancellation carries the cancelling vessel MMSI', () => {
  const ev = parseDsc(parts('$CDDSC,12,3381581370,12,06,00,1423108312,0236,3381581370,,S,*20'));
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '338158137');
  assert.equal(ev.distressedMmsi, '338158137');
});

test('EPIRB MAYDAY relay is flagged and names the casualty, not the relaying station', () => {
  // An all-ships distress relay of an EPIRB activation: a coast/ship station
  // (field 1) re-broadcasts another vessel's distress. Format is allShips (not
  // distressAlert); field 3 is the relay telecommand (112), the casualty's
  // MMSI is in field 7, the casualty's position in field 5.
  const ev = parseDsc(parts('$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,12,,*00'));
  assert.equal(ev.format, 'allShips');
  assert.equal(ev.category, 'distress');
  assert.equal(ev.relay, true);
  assert.equal(ev.mmsi, '003160001'); // the relaying station
  assert.equal(ev.distressedMmsi, '316200911'); // the vessel in distress
  assert.ok(ev.position); // 1423108312 → NW quadrant, casualty position
  assert.equal(ev.utcTime, '20:19');
});

test('EPIRB relay reads nature of distress from field 8, not the relay telecommand', () => {
  // In a relay, field 3 is the relay telecommand (112), not a nature code, and
  // the nature lives in field 8 (12 = EPIRB emission). Reading field 3 as a
  // nature would mis-resolve (112 → 'undesignated'); the real nature is 'epirb'.
  const ev = parseDsc(parts('$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,12,,*00'));
  assert.equal(ev.natureOfDistress, 'epirb');
});

test('relay nature field is still sanitised against unsafe tokens', () => {
  // Field 8 arrives over the air like every other field — a hostile value must
  // collapse to a safe constant, same guard as the field-3 path (#2768).
  const ev = parseDsc(parts('$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,__proto__,,*00'));
  assert.equal(ev.natureOfDistress, 'undesignated');
});

test('first-party distress alert is not flagged as a relay', () => {
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ev.relay, undefined);
  assert.equal(ev.natureOfDistress, 'adrift'); // still read from field 3
});

test('AIS EPIRB sending DSC directly is tagged as an EPIRB device beacon', () => {
  // Modern AIS EPIRBs (device MMSI 974MMMMMM) broadcast their own DSC distress
  // directly — a first-party alert, not a relay. Tagging the device class lets
  // the consumer correlate it with the matching AIS-EPIRB target.
  const ev = parseDsc(parts('$CDDSC,12,9743210980,12,12,00,1423108312,2019,,,S,E*00'));
  assert.equal(ev.category, 'distress');
  assert.equal(ev.mmsi, '974321098');
  assert.equal(ev.natureOfDistress, 'epirb');
  assert.equal(ev.relay, undefined);
  assert.equal(ev.deviceBeacon, 'epirb');
});

test('AIS MOB and SART device MMSIs are tagged distinctly; ordinary ships are not', () => {
  const mob = parseDsc(parts('$CDDSC,12,9723210980,12,10,00,1423108312,2019,,,S,E*00'));
  assert.equal(mob.deviceBeacon, 'mob');
  const sart = parseDsc(parts('$CDDSC,12,9703210980,12,07,00,1423108312,2019,,,S,E*00'));
  assert.equal(sart.deviceBeacon, 'sart');
  const ship = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ship.deviceBeacon, undefined);
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

test('routine individual call with bare working channel digits', () => {
  // tc1=00 (all modes TP): field 5 is a channel, not a position.
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,0072,1902,,,B,E*7B'));
  assert.equal(ev.category, 'routine');
  assert.equal(ev.workingChannel, '72');
  assert.equal(ev.position, undefined);
});

test('M.493 9-prefixed channel encoding is normalized', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,900072,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, '72');
});

test('four-digit simplex channels survive intact', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,1078,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, '1078');
});

test('position telecommand (21) never yields a working channel', () => {
  // Existing routine-position sentence: tc1=21 → field 5 is a position.
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, undefined);
  assert.ok(ev.position);
});

test('distress alerts never yield a working channel', () => {
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ev.workingChannel, undefined);
});

test('hostile or implausible channel fields are dropped', () => {
  for (const bad of ['__proto__', '12.3', 'constructor', '4242424242', '218450', '0', '100', '3001', '']) {
    const ev = parseDsc(parts(`$CDDSC,20,3381581370,00,00,26,${bad},1902,,,B,E*00`));
    assert.equal(ev.workingChannel, undefined, `expected ${JSON.stringify(bad)} to be dropped`);
  }
});
