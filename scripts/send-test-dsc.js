#!/usr/bin/env node
'use strict';

/*
 * send-test-dsc.js — inject a fake DSC sentence into a SignalK server via UDP.
 *
 * Usage:
 *   node scripts/send-test-dsc.js [options]
 *
 * Options:
 *   --host <host>      UDP target host (default: naturalaspi)
 *   --port <port>      UDP target port (default: 7777)
 *   --nature <name>    Nature of distress: fire, flooding, collision, grounding,
 *                      listing, sinking, adrift, abandon, piracy, mob, epirb
 *                      (default: sinking)
 *   --mmsi <mmsi>      9-digit MMSI of the vessel in distress (default: 366191919)
 *   --lat <deg>        Latitude in decimal degrees, positive = N (default: 48.75)
 *   --lon <deg>        Longitude in decimal degrees, negative = W (default: -123.25)
 *   --category <cat>   distress | urgency | safety | routine (default: distress)
 *
 * Examples:
 *   node scripts/send-test-dsc.js
 *   node scripts/send-test-dsc.js --nature fire --mmsi 316123456
 *   node scripts/send-test-dsc.js --host localhost --port 7777 --lat 48.76 --lon -123.1
 */

const dgram = require('node:dgram');

// DSC nature-of-distress codes (ITU-R M.493 field 3 on format 12)
const NATURE_CODES = {
  fire:       '00',
  flooding:   '01',
  collision:  '02',
  grounding:  '03',
  listing:    '04',
  sinking:    '05',
  adrift:     '06',
  abandon:    '08',
  piracy:     '09',
  mob:        '10',
  epirb:      '12',
};

// DSC category codes
const CATEGORY_CODES = {
  routine:  '00',
  safety:   '08',
  urgency:  '10',
  distress: '12',
};

// 1st telecommand 21 = "ship position". Per ITU-R M.493 a non-distress call only
// carries a position when this telecommand is set; otherwise field 5 is a working
// channel. We always send a position, so non-distress calls use it (see buildSentence).
const TELECOMMAND_SHIP_POSITION = '21';

function parseArgs(argv) {
  const args = { host: 'naturalaspi', port: 7777, nature: 'sinking',
                 mmsi: '366191919', lat: 48.75, lon: -123.25, category: 'distress' };
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], val = argv[i + 1];
    if (flag === '--host')     args.host = val;
    if (flag === '--port')     args.port = Number(val);
    if (flag === '--nature')   args.nature = val;
    if (flag === '--mmsi')     args.mmsi = val;
    if (flag === '--lat')      args.lat = parseFloat(val);
    if (flag === '--lon')      args.lon = parseFloat(val);
    if (flag === '--category') args.category = val;
  }
  return args;
}

// Encode decimal lat/lon into the DSC 10-char position field (QDDMMDDDMM).
function encodePosition(lat, lon) {
  const quadrant = lat >= 0 && lon >= 0 ? 0
                 : lat >= 0 && lon < 0  ? 1
                 : lat < 0  && lon >= 0 ? 2
                                        : 3;
  const absLat = Math.abs(lat), absLon = Math.abs(lon);
  const latDeg = Math.floor(absLat);
  const latMin = Math.floor((absLat - latDeg) * 60);
  const lonDeg = Math.floor(absLon);
  const lonMin = Math.floor((absLon - lonDeg) * 60);
  return `${quadrant}${String(latDeg).padStart(2, '0')}${String(latMin).padStart(2, '0')}${String(lonDeg).padStart(3, '0')}${String(lonMin).padStart(2, '0')}`;
}

function nmeaChecksum(body) {
  let cksum = 0;
  for (const c of body) cksum ^= c.charCodeAt(0);
  return cksum.toString(16).toUpperCase().padStart(2, '0');
}

function buildSentence({ mmsi, category, nature, lat, lon }) {
  const formatCode = category === 'distress' ? '12' : category === 'urgency' ? '16' : category === 'safety' ? '16' : '20';
  const categoryCode = CATEGORY_CODES[category] ?? '12';
  const mmsi10 = String(mmsi).padEnd(9, '0').substring(0, 9) + '0'; // 9-digit MMSI + trailing zero
  const pos = encodePosition(lat, lon);
  const now = new Date();
  const utcTime = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;

  // Field 3 is the nature of distress on a distress alert, but the 1st telecommand
  // on every other call — and a non-distress call only carries a position (field 5)
  // when that telecommand is 21 (ship position). So distress -> nature, everything
  // else -> 21, so the supplied --lat/--lon is honored for all categories.
  const firstField = category === 'distress'
    ? (NATURE_CODES[nature] ?? '07')
    : TELECOMMAND_SHIP_POSITION;

  const body = `CDDSC,${formatCode},${mmsi10},${categoryCode},${firstField},00,${pos},${utcTime},,,S,E`;
  return `$${body}*${nmeaChecksum(body)}`;
}

function send(sentence, host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(sentence + '\r\n');
    sock.send(buf, port, host, (err) => {
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!NATURE_CODES[args.nature] && args.category === 'distress') {
    console.error(`Unknown nature "${args.nature}". Valid: ${Object.keys(NATURE_CODES).join(', ')}`);
    process.exit(1);
  }
  if (!CATEGORY_CODES[args.category]) {
    console.error(`Unknown category "${args.category}". Valid: ${Object.keys(CATEGORY_CODES).join(', ')}`);
    process.exit(1);
  }

  const sentence = buildSentence(args);
  console.log(`Sending: ${sentence}`);
  console.log(`     to: udp://${args.host}:${args.port}`);

  await send(sentence, args.host, args.port);
  console.log('Sent. Check /signalk/v2/api/resources/dsc-calls on the server.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
