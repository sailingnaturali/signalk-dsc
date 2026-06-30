'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, buildLogbookText } = require('../lib/format');

const DISTRESS_EVENT = {
  category: 'distress',
  mmsi: '338040079',
  natureOfDistress: 'sinking',
  position: { latitude: 48.795, longitude: -123.265 },
  utcTime: '20:19',
  receivedAt: '2026-06-06T20:19:30.000Z',
  source: 'nmea0183',
};

const OWN_POSITION = { latitude: 48.7621, longitude: -123.2345 };

test('voice message with own position is compact: type, vessel, situation, range, direction, action', () => {
  const msg = buildMessage(DISTRESS_EVENT, { ownPosition: OWN_POSITION, vesselName: 'Wind Chaser' });
  assert.equal(
    msg,
    'DSC distress alert: vessel Wind Chaser, sinking, 2.3 nautical miles northwest. Monitor channel 16.'
  );
});

test('no MMSI in the spoken line when the vessel name is unknown (TTS reads it as a number)', () => {
  const msg = buildMessage(DISTRESS_EVENT, { ownPosition: OWN_POSITION });
  assert.equal(
    msg,
    'DSC distress alert: unidentified vessel, sinking, 2.3 nautical miles northwest. Monitor channel 16.'
  );
});

test('voice message falls back to coordinates without own position', () => {
  const msg = buildMessage(DISTRESS_EVENT, {});
  assert.match(msg, /^DSC distress alert: unidentified vessel, sinking, position 48°47\.700′N 123°15\.900′W\. Monitor channel 16\.$/);
});

test('distress without any position still reads sanely', () => {
  const msg = buildMessage({ category: 'distress', mmsi: '338040079', natureOfDistress: 'mob' }, {});
  assert.equal(msg, 'DSC distress alert: unidentified vessel, man overboard, position unknown. Monitor channel 16.');
});

test('urgency call message has no channel-16 action and no nature', () => {
  const msg = buildMessage(
    { category: 'urgency', mmsi: '366999707', position: { latitude: 48.795, longitude: -123.265 } },
    { ownPosition: OWN_POSITION }
  );
  assert.equal(msg, 'DSC urgency call: unidentified vessel, 2.3 nautical miles northwest.');
});

test('logbook text keeps the full detail the voice line drops', () => {
  const text = buildLogbookText(DISTRESS_EVENT, { ownPosition: OWN_POSITION, vesselName: 'Wind Chaser' });
  assert.match(text, /^\[DSC\] DISTRESS alert/);
  assert.match(text, /Wind Chaser/);
  assert.match(text, /MMSI 338040079/);
  assert.match(text, /sinking/);
  assert.match(text, /48°47\.700′N 123°15\.900′W/);
  assert.match(text, /20:19 UTC/);
  assert.match(text, /2\.3 NM northwest of us/);
  assert.match(text, /via nmea0183/);
});

const RELAY_EVENT = {
  category: 'distress',
  relay: true,
  mmsi: '003160001', // relaying station
  distressedMmsi: '316200911', // casualty
  natureOfDistress: 'epirb',
  position: { latitude: 48.795, longitude: -123.265 },
  utcTime: '20:19',
  source: 'nmea0183',
};

test('a relay is spoken as a distress relay, not a first-party alert', () => {
  const msg = buildMessage(RELAY_EVENT, { ownPosition: OWN_POSITION });
  assert.match(msg, /^DSC distress relay:/);
  assert.match(msg, /EPIRB emission/);
  assert.match(msg, /Monitor channel 16\.$/);
});

test('relay logbook entry names the casualty and the relaying station', () => {
  const text = buildLogbookText(RELAY_EVENT, {});
  assert.match(text, /DISTRESS RELAY/);
  assert.match(text, /316200911/); // the casualty
  assert.match(text, /003160001/); // the relaying station
  assert.match(text, /EPIRB emission/);
});

test('logbook text mentions the proposed working channel', () => {
  const text = buildLogbookText({
    category: 'routine',
    mmsi: '338158137',
    workingChannel: '72',
    source: 'nmea0183',
  });
  assert.match(text, /proposed working channel 72/);
});

test('no working-channel clause when the call had none', () => {
  const text = buildLogbookText({ category: 'routine', mmsi: '338158137' });
  assert.doesNotMatch(text, /working channel/);
});
