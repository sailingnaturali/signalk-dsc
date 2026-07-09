'use strict';

/*
 * Map a normalized DSC event onto a DSCWatch report body
 * (POST https://dscwatch.com/api/v1/report/<receiver-key>).
 *
 * Pure field-picker: send what we have, omit what we don't. The pick-list is
 * also the privacy boundary — local-only fields (id, message, repeats,
 * lastReceivedAt, ownShip, clearedAt) are never sent because they are never
 * picked. Boolean flags go out only when true; parseDsc always materializes
 * `expansion` as false and the API treats absence as false.
 */

const FIELDS = [
  'receivedAt',
  'source',
  'category',
  'format',
  'raw',
  'mmsi',
  'position',
  'positionResolution',
  'utcTime',
  'natureOfDistress',
  'distressedMmsi',
  'deviceBeacon',
  'workingChannel',
  'acknowledgement',
];

const FLAGS = ['relay', 'expansion', 'self', 'positionRefined'];

function buildReport(event, { ownPosition } = {}) {
  const body = {};
  for (const key of FIELDS) {
    if (event[key] !== undefined) body[key] = event[key];
  }
  for (const key of FLAGS) {
    if (event[key] === true) body[key] = true;
  }
  if (!body.format) body.format = 'unknown';
  if (ownPosition && typeof ownPosition.latitude === 'number') {
    body.ownPosition = { latitude: ownPosition.latitude, longitude: ownPosition.longitude };
  }
  return body;
}

module.exports = { buildReport };
