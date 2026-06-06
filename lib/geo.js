'use strict';

/* Range and bearing from own ship to a reported position, for voice alerts. */

const EARTH_RADIUS_NM = 3440.065;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceNm(from, to) {
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(a)) * EARTH_RADIUS_NM;
}

function bearingDegrees(from, to) {
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS_WORDS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

function compassWord(bearing) {
  return COMPASS_WORDS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

module.exports = { distanceNm, bearingDegrees, compassWord };
