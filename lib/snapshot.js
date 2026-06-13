'use strict';

/*
 * Own-ship context snapshot, taken at DSC call receive time.
 *
 * The stored event is the forensic record of the moment a call arrived; the
 * snapshot answers "what was our situation when we heard it". Values are
 * stored exactly as SignalK provides them (rad, m/s, Pa, meters) — absent
 * sensor, absent field, never fabricated. Conversion to logbook units
 * happens only in buildObservations.
 */

const DEFAULT_SNAPSHOT_FIELDS = [
  { field: 'position', path: 'navigation.position' },
  { field: 'cog', path: 'navigation.courseOverGroundTrue' },
  { field: 'sog', path: 'navigation.speedOverGround' },
  { field: 'heading', path: 'navigation.headingTrue' },
  { field: 'wind.speed', path: 'environment.wind.speedOverGround' },
  { field: 'wind.direction', path: 'environment.wind.directionTrue' },
  { field: 'pressure', path: 'environment.outside.pressure' },
  // signalk-logbook conventions (no SignalK spec paths exist for these).
  { field: 'seaState', path: 'environment.water.swell.state' },
  { field: 'visibility', path: 'environment.outside.visibility' },
  { field: 'cloudCoverage', path: 'environment.outside.cloudCoverage' },
];

const UNSAFE_KEY = /^(__proto__|constructor|prototype)$/;

function unwrap(node) {
  return node && typeof node === 'object' && 'value' in node ? node.value : node;
}

/** Read the default + configured paths off the data model. Best-effort:
 *  a throwing read skips that field. Returns undefined when empty. */
function captureOwnShip(app, extraFields = []) {
  const snapshot = {};
  const fields = DEFAULT_SNAPSHOT_FIELDS.concat(Array.isArray(extraFields) ? extraFields : []);
  for (const entry of fields) {
    if (!entry || typeof entry.field !== 'string' || typeof entry.path !== 'string') continue;
    const keys = entry.field.split('.');
    if (keys.some((k) => !k || UNSAFE_KEY.test(k))) continue;
    let value;
    try {
      value = unwrap(app.getSelfPath(entry.path));
    } catch {
      continue;
    }
    // Decouple from the live data model and refuse anything that could
    // break the JSON store on the alarm-critical receive path.
    try {
      value = JSON.parse(JSON.stringify(value));
    } catch {
      continue;
    }
    if (value === undefined || value === null) continue;
    let target = snapshot;
    for (const key of keys.slice(0, -1)) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
      target = target[key];
    }
    target[keys[keys.length - 1]] = value;
  }
  return Object.keys(snapshot).length ? snapshot : undefined;
}

// Upper bounds (meters, exclusive) for fog-scale codes 0–8; ≥50 km is 9.
const FOG_SCALE_METERS = [50, 200, 500, 1000, 2000, 4000, 10000, 20000, 50000];

/** Meters → logbook fog-scale 0–9. A small integer (≤9) is assumed to
 *  already be a fog-scale code and passes through. */
function visibilityToFogScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (Number.isInteger(value) && value <= 9) return value;
  const idx = FOG_SCALE_METERS.findIndex((limit) => value < limit);
  return idx === -1 ? 9 : idx;
}

/** signalk-logbook observations block from a snapshot. Only keys with valid
 *  values; undefined when there are none. */
function buildObservations(ownShip) {
  if (!ownShip) return undefined;
  const obs = {};
  if (Number.isInteger(ownShip.seaState) && ownShip.seaState >= 0 && ownShip.seaState <= 9) {
    obs.seaState = ownShip.seaState;
  }
  if (
    Number.isInteger(ownShip.cloudCoverage) &&
    ownShip.cloudCoverage >= 0 &&
    ownShip.cloudCoverage <= 8
  ) {
    obs.cloudCoverage = ownShip.cloudCoverage;
  }
  const visibility = visibilityToFogScale(ownShip.visibility);
  if (visibility !== undefined) obs.visibility = visibility;
  return Object.keys(obs).length ? obs : undefined;
}

module.exports = { captureOwnShip, buildObservations, visibilityToFogScale, unwrap, DEFAULT_SNAPSHOT_FIELDS };
