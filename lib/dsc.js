'use strict';

/*
 * $--DSC sentence parsing (ITU-R M.493 datagram as flattened by NMEA 0183).
 *
 * Field reference: http://continuouswave.com/whaler/reference/DSC_Datagrams.html
 *
 *        0  1          2  3  4  5          6    7 8 9 10
 *        |  |          |  |  |  |          |    | | | |
 * $--DSC,XX,XXXXXXXXXX,XX,XX,XX,XXXXXXXXXX,XXXX,,,A,C*hh
 *
 *  0: format specifier (ITU symbol minus the leading 1: 12 = 112 distress alert)
 *  1: address — MMSI * 10 (trailing zero). Distress alert: vessel in distress.
 *  2: category (00 routine / 08 safety / 10 urgency / 12 distress)
 *  3: nature of distress, or 1st telecommand for non-distress calls
 *  4: subsequent comms / 2nd telecommand
 *  5: position (quadrant + ddmm + dddmm, truncated toward zero) or channel/number
 *  6: UTC time hhmm (8888 = unavailable)
 *  7: MMSI of vessel in distress (relays/acknowledgements/cancellations)
 *  8: nature of distress (relays)
 *  9: acknowledgement (R/B/S)
 * 10: expansion flag — 'E' means a $--DSE sentence follows
 */

const FORMATS = {
  '02': 'area',
  '12': 'distressAlert',
  '14': 'group',
  '16': 'allShips',
  '20': 'individual',
  '23': 'autoService',
};

const CATEGORIES = {
  '00': 'routine',
  '08': 'safety',
  '10': 'urgency',
  '12': 'distress',
};

const NATURES = {
  '00': 'fire',
  '01': 'flooding',
  '02': 'collision',
  '03': 'grounding',
  '04': 'listing',
  '05': 'sinking',
  '06': 'adrift',
  '07': 'undesignated',
  '08': 'abandon',
  '09': 'piracy',
  '10': 'mob',
  '12': 'epirb',
};

// Telecommand 21 on a non-distress call = "ship position" — field 5 holds a position.
const TELECOMMAND_SHIP_POSITION = '21';

function field(parts, i) {
  const v = parts[i];
  return typeof v === 'string' ? v.trim() : '';
}

function parseMmsi(raw) {
  if (typeof raw !== 'string') return undefined;
  const digits = raw.trim();
  if (!/^\d{9,10}$/.test(digits)) return undefined;
  // DSC sentences carry the MMSI with a trailing zero (MMSI * 10).
  return digits.length === 10 ? digits.substring(0, 9) : digits;
}

function parsePosition(raw) {
  if (typeof raw !== 'string' || !/^\d{10}$/.test(raw)) return undefined;
  if (raw === '9999999999') return undefined; // "position not available"
  const quadrant = Number(raw[0]); // 0 NE, 1 NW, 2 SE, 3 SW
  if (quadrant > 3) return undefined;
  let latitude = Number(raw.substring(1, 3)) + Number(raw.substring(3, 5)) / 60;
  let longitude = Number(raw.substring(5, 8)) + Number(raw.substring(8, 10)) / 60;
  if (quadrant === 1 || quadrant === 3) longitude = -longitude;
  if (quadrant === 2 || quadrant === 3) latitude = -latitude;
  return { latitude, longitude };
}

function parseUtcTime(raw) {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw.trim())) return undefined;
  const t = raw.trim();
  if (t === '8888') return undefined; // "time not available"
  return `${t.substring(0, 2)}:${t.substring(2, 4)}`;
}

/**
 * Parse the comma-split fields of a $--DSC sentence (sentence id and checksum
 * already stripped) into a partial DSC event. Tolerant by design: anything we
 * cannot interpret stays undefined and the caller keeps the raw sentence.
 * Returns null only when there is nothing usable at all.
 */
function parseDsc(parts) {
  if (!Array.isArray(parts) || parts.length < 2) return null;

  const formatCode = field(parts, 0);
  let categoryCode = field(parts, 2);
  // Some radios omit the category on distress alerts — it is implied by
  // format 112 (see SignalK/nmea0183-signalk#217).
  if (!categoryCode && formatCode === '12') categoryCode = '12';

  const event = {
    format: FORMATS[formatCode] || 'unknown',
    category: CATEGORIES[categoryCode] || 'unknown',
    mmsi: parseMmsi(parts[1]),
  };

  const distress = event.category === 'distress';
  if (distress) {
    const natureCode = field(parts, 3);
    event.natureOfDistress =
      NATURES[natureCode] || (natureCode ? `code-${natureCode}` : 'undesignated');
    event.distressedMmsi = parseMmsi(parts[7]);
  }

  if (distress || field(parts, 3) === TELECOMMAND_SHIP_POSITION) {
    event.position = parsePosition(field(parts, 5));
    event.utcTime = parseUtcTime(field(parts, 6));
  }

  const ack = field(parts, 9);
  if (ack) event.acknowledgement = ack;
  event.expansion = field(parts, 10) === 'E';

  return event;
}

module.exports = { parseDsc, parsePosition, parseMmsi, parseUtcTime, NATURES };
