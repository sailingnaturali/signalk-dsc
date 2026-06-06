'use strict';

/* Human-readable summaries for notifications and ship's-log entries. */

const NATURE_TEXT = {
  fire: 'fire/explosion',
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

function buildMessage(event) {
  if (event.category === 'distress') {
    const nature = NATURE_TEXT[event.natureOfDistress] || event.natureOfDistress || 'undesignated distress';
    const subject = event.distressedMmsi || event.mmsi || 'unknown';
    let msg = `DSC DISTRESS from MMSI ${subject}: ${nature}`;
    if (event.position) msg += `. Position ${formatPosition(event.position)}`;
    if (event.utcTime) msg += ` at ${event.utcTime} UTC`;
    return `${msg}. Monitor channel 16.`;
  }
  const kind = event.category === 'unknown' ? 'call' : `${event.category} call`;
  let msg = `DSC ${kind} from MMSI ${event.mmsi || 'unknown'}`;
  if (event.position) msg += ` reporting position ${formatPosition(event.position)}`;
  if (event.utcTime) msg += ` at ${event.utcTime} UTC`;
  return msg;
}

function buildLogbookText(event) {
  return `[DSC] ${buildMessage(event)}`;
}

module.exports = { buildMessage, buildLogbookText, formatPosition };
