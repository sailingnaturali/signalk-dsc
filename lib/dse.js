'use strict';

/*
 * $--DSE sentence parsing — the expansion that can follow a $--DSC sentence,
 * refining its position from whole minutes to ten-thousandths of a minute.
 *
 *        0 1 2 3          4  5
 * $--DSE,t,n,A,XXXXXXXXXX,00,llllyyyy*hh
 *
 *  0: total sentences in this group
 *  1: sentence number
 *  2: query flag ('A' = automatic/unsolicited)
 *  3: address — MMSI * 10, same convention as DSC
 *  4+: repeated (code, data) pairs; code 00 = enhanced position resolution,
 *      data = 4 digits lat + 4 digits lon, in 1/10000 of a minute
 */

const { parseMmsi } = require('./dsc');

const CODE_ENHANCED_POSITION = '00';

/**
 * Returns { mmsi, latMinuteFraction, lonMinuteFraction } for single-sentence
 * DSE groups carrying a position extension, else null.
 */
function parseDse(parts) {
  if (!Array.isArray(parts) || parts.length < 6) return null;
  // Multi-sentence groups are vanishingly rare on Class-D gear; skip them.
  if (parts[0].trim() !== '1' || parts[1].trim() !== '1') return null;

  const mmsi = parseMmsi(parts[3]);
  if (!mmsi) return null;

  for (let i = 4; i + 1 < parts.length; i += 2) {
    const code = (parts[i] || '').trim();
    const data = (parts[i + 1] || '').trim();
    if (code === CODE_ENHANCED_POSITION && /^\d{8}$/.test(data)) {
      return {
        mmsi,
        latMinuteFraction: Number(data.substring(0, 4)) / 10000,
        lonMinuteFraction: Number(data.substring(4, 8)) / 10000,
      };
    }
  }
  return null;
}

/**
 * Apply a DSE extension to a DSC position. DSC truncates coordinates toward
 * zero, so the fractional minutes always extend the magnitude (sign-preserving).
 */
function refinePosition(position, ext) {
  const extend = (value, minuteFraction) => {
    const sign = value < 0 ? -1 : 1;
    return sign * (Math.abs(value) + minuteFraction / 60);
  };
  return {
    latitude: extend(position.latitude, ext.latMinuteFraction),
    longitude: extend(position.longitude, ext.lonMinuteFraction),
  };
}

module.exports = { parseDse, refinePosition };
