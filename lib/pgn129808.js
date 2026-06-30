'use strict';

/*
 * NMEA 2000 PGN 129808 "DSC (Distress) Call Information" → canonical DSC event.
 *
 * canboatjs (useCamelCompat) resolves lookups to their names; the distress
 * variant uses dscFormat/dscCategory/natureOfDistress, the general variant
 * dscFormatSymbol/dscCategorySymbol. When a lookup cannot be resolved the raw
 * ITU symbol number (1xx) comes through instead — handle both.
 */

const { deviceBeaconFor } = require('./dsc');

// Lookup-name → canonical (lowercased keys); ITU symbols as numeric fallback.
const FORMATS = new Map([
  ['geographical area', 'area'],
  ['distress', 'distressAlert'],
  ['common interest', 'group'],
  ['group call', 'group'],
  ['all ships', 'allShips'],
  ['individual stations', 'individual'],
  ['individual station automatic', 'autoService'],
  [102, 'area'],
  [112, 'distressAlert'],
  [114, 'group'],
  [116, 'allShips'],
  [120, 'individual'],
  [123, 'autoService'],
]);

const CATEGORIES = new Map([
  ['routine', 'routine'],
  ['safety', 'safety'],
  ['urgency', 'urgency'],
  ['distress', 'distress'],
  [100, 'routine'],
  [108, 'safety'],
  [110, 'urgency'],
  [112, 'distress'],
]);

const NATURES = new Map([
  ['fire, explosion', 'fire'],
  ['flooding', 'flooding'],
  ['collision', 'collision'],
  ['grounding', 'grounding'],
  ['listing, in danger of capsizing', 'listing'],
  ['sinking', 'sinking'],
  ['disabled and adrift', 'adrift'],
  ['undesignated distress', 'undesignated'],
  ['abandoning ship', 'abandon'],
  ['piracy/armed robbery attack', 'piracy'],
  ['man overboard', 'mob'],
  ['epirb emission', 'epirb'],
  [0, 'fire'],
  [1, 'flooding'],
  [2, 'collision'],
  [3, 'grounding'],
  [4, 'listing'],
  [5, 'sinking'],
  [6, 'adrift'],
  [7, 'undesignated'],
  [8, 'abandon'],
  [9, 'piracy'],
  [10, 'mob'],
  [12, 'epirb'],
]);

function lookup(map, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const hit = map.get(value.trim().toLowerCase());
    if (hit) return hit;
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) return map.get(asNumber);
    return undefined;
  }
  return map.get(value);
}

function normalizeMmsi(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const digits = String(value).trim();
  if (!/^\d{1,9}$/.test(digits)) return undefined;
  if (Number(digits) === 0) return undefined;
  return digits.padStart(9, '0');
}

function normalizeTime(value) {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    return undefined;
  }
  if (typeof value === 'number' && value >= 0 && value < 86400) {
    // Seconds since midnight.
    const h = String(Math.floor(value / 3600)).padStart(2, '0');
    const min = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
    return `${h}:${min}`;
  }
  return undefined;
}

/** Normalize a canboatjs-parsed PGN 129808 object into a canonical DSC event. */
function normalizePgn129808(pgnData) {
  const f = (pgnData && pgnData.fields) || {};

  const event = {
    format: lookup(FORMATS, f.dscFormat ?? f.dscFormatSymbol) || 'unknown',
    category: lookup(CATEGORIES, f.dscCategory ?? f.dscCategorySymbol) || 'unknown',
    mmsi: normalizeMmsi(f.dscMessageAddress),
  };

  const beacon = deviceBeaconFor(event.mmsi);
  if (beacon) event.deviceBeacon = beacon;

  if (event.category === 'distress') {
    const nature = f.natureOfDistress ?? f['1stTelecommand'];
    event.natureOfDistress = lookup(NATURES, nature) || 'undesignated';
    // A distress *relay* arrives under a calling format (all-ships / area /
    // individual), not the distressAlert format of a first-party alert. The
    // PGN already carries the casualty's nature + MMSI in dedicated fields.
    if (event.format !== 'distressAlert') event.relay = true;
  }

  const lat = f.latitudeOfVesselReported;
  const lon = f.longitudeOfVesselReported;
  if (typeof lat === 'number' && typeof lon === 'number') {
    event.position = { latitude: lat, longitude: lon };
  }

  const time = normalizeTime(f.timeOfPosition);
  if (time) event.utcTime = time;

  const distressed = normalizeMmsi(f.mmsiOfShipInDistress);
  if (distressed) event.distressedMmsi = distressed;

  return event;
}

module.exports = { normalizePgn129808 };
