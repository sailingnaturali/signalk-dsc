#!/usr/bin/env node
'use strict';

/*
 * Regenerate the CAPTURED fixtures in test/pgn129808-canboat.test.js from a
 * real canboatjs decode, so they never drift back into being assumptions.
 *
 *   npm i --no-save @canboat/canboatjs
 *   node scripts/capture-129808.js
 *
 * Method: encode one known-good distress frame, then patch data bytes 0 and 1
 * (DSC Format, DSC Category) to synthesize each call type. Both 129808 variants
 * share an identical 22-field bit layout, so the patched frames are structurally
 * valid — this avoids the encoder, which silently writes 0xff for general-variant
 * field names and would make "never encoded" look like "decoder dropped it".
 *
 * Verified to give identical results via the actisense, YDRAW (YachtDevices) and
 * PCDIN input paths.
 */

let canboat;
try {
  canboat = require('@canboat/canboatjs');
} catch {
  console.error('Needs canboatjs:  npm i --no-save @canboat/canboatjs');
  process.exit(1);
}

const base = canboat.pgnToActisenseSerialFormat({
  pgn: 129808,
  dst: 255,
  src: 3,
  prio: 3,
  fields: {
    dscFormat: 'Distress',
    dscCategory: 'Distress',
    dscMessageAddress: '338040079',
    natureOfDistress: 'Sinking',
    latitudeOfVesselReported: 48.7621,
    longitudeOfVesselReported: -123.2345,
    timeOfPosition: '18:00:00',
    mmsiOfShipInDistress: '338040079',
  },
});

const parts = base.split(',');
const HDR = 6; // timestamp,prio,pgn,src,dst,len then data
const hex = (n) => n.toString(16).padStart(2, '0');

// label -> [DSC Format symbol, DSC Category symbol]
const CASES = {
  distressAlert: [112, 112],
  distressRelay: [116, 112],
  urgency: [116, 110],
  safety: [116, 108],
  routine: [120, 100],
};

const out = {};
for (const [label, [fmt, cat]] of Object.entries(CASES)) {
  const p = parts.slice();
  p[HDR] = hex(fmt);
  p[HDR + 1] = hex(cat);
  const decoded = new canboat.FromPgn({ useCamelCompat: true }).parseString(p.join(','));
  // Drop the camelCompat spaced duplicates and the empty repeating-field list.
  const fields = {};
  for (const [k, v] of Object.entries(decoded.fields)) {
    if (!k.includes(' ') && k !== 'list') fields[k] = v;
  }
  out[label] = fields;
  const catKey = Object.keys(fields).find((k) => /categ/i.test(k));
  console.error(
    `  ${label.padEnd(14)} -> ${decoded.description.padEnd(30)} ` +
      `category: ${catKey ? catKey + '=' + fields[catKey] : 'DROPPED'}`
  );
}

console.error('\n// paste into test/pgn129808-canboat.test.js as CAPTURED\n');
console.log(JSON.stringify(out, null, 2));
