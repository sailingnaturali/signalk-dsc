'use strict';

/*
 * Two renderings of a DSC event:
 *
 * - buildMessage: the notification message. This ends up SPOKEN by the voice
 *   pipeline, so it is deliberately minimal — type, vessel, situation, range
 *   and direction from us, action. Nothing else.
 * - buildLogbookText: the ship's-log entry — full detail (MMSI, coordinates,
 *   reported time, transport), GMDSS radio-log style.
 */

const { distanceNm, bearingDegrees, compassWord } = require('./geo');

const NATURE_TEXT = {
  fire: 'fire and explosion',
  flooding: 'flooding',
  collision: 'collision',
  grounding: 'grounding',
  listing: 'listing, in danger of capsize',
  sinking: 'sinking',
  adrift: 'disabled and adrift',
  undesignated: 'undesignated distress',
  abandon: 'abandoning ship',
  piracy: 'piracy attack',
  mob: 'man overboard',
  epirb: 'EPIRB emission',
};

function formatCoordinate(value, axis) {
  const hemisphere = axis === 'lat' ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E';
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 60;
  return `${degrees}°${minutes.toFixed(3)}′${hemisphere}`;
}

function formatPosition(position) {
  return `${formatCoordinate(position.latitude, 'lat')} ${formatCoordinate(position.longitude, 'lon')}`;
}

function vesselPhrase(event, vesselName) {
  return `vessel ${vesselName || `MMSI ${event.mmsi || 'unknown'}`}`;
}

/** "2.3 nautical miles northwest" | "position 48°47.700′N ..." | "position unknown" */
function wherePhrase(event, ownPosition, { spoken }) {
  if (event.position && ownPosition) {
    const range = distanceNm(ownPosition, event.position);
    const direction = compassWord(bearingDegrees(ownPosition, event.position));
    const unit = spoken ? 'nautical miles' : 'NM';
    const suffix = spoken ? '' : ' of us';
    return `${range.toFixed(1)} ${unit} ${direction}${suffix}`;
  }
  if (event.position) return `position ${formatPosition(event.position)}`;
  return 'position unknown';
}

function buildMessage(event, { ownPosition, vesselName } = {}) {
  const who = vesselPhrase(event, vesselName);
  const where = wherePhrase(event, ownPosition, { spoken: true });
  if (event.category === 'distress') {
    const nature = NATURE_TEXT[event.natureOfDistress] || event.natureOfDistress || 'undesignated distress';
    return `DSC distress alert: ${who}, ${nature}, ${where}. Monitor channel 16.`;
  }
  const kind = event.category === 'unknown' ? 'call' : `${event.category} call`;
  return `DSC ${kind}: ${who}, ${where}.`;
}

function buildLogbookText(event, { ownPosition, vesselName } = {}) {
  const parts = [];
  const name = vesselName ? `${vesselName} (MMSI ${event.mmsi || 'unknown'})` : `MMSI ${event.mmsi || 'unknown'}`;
  if (event.category === 'distress') {
    const nature = NATURE_TEXT[event.natureOfDistress] || event.natureOfDistress || 'undesignated distress';
    parts.push(`DISTRESS alert from ${name}: ${nature}`);
  } else {
    parts.push(`${event.category} call from ${name}`);
  }
  if (event.position) {
    let pos = `position ${formatPosition(event.position)}`;
    if (event.utcTime) pos += ` at ${event.utcTime} UTC`;
    if (ownPosition) pos += `, ${wherePhrase(event, ownPosition, { spoken: false })}`;
    parts.push(pos);
  } else if (event.utcTime) {
    parts.push(`reported at ${event.utcTime} UTC`);
  }
  if (event.source) parts.push(`via ${event.source}`);
  return `[DSC] ${parts.join('. ')}`;
}

module.exports = { buildMessage, buildLogbookText, formatPosition };
