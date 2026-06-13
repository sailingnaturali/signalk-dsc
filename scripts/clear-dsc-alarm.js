#!/usr/bin/env node
'use strict';

/*
 * clear-dsc-alarm.js — clear an active DSC alarm on a SignalK server.
 *
 * Clearing is a write, so it needs a readwrite token (the same SIGNALK_TOKEN
 * that fires a test MOB). It drops the live notification AND marks the stored
 * call so a server restart will not re-raise it.
 *
 * Usage:
 *   node scripts/clear-dsc-alarm.js [options]
 *   SIGNALK_TOKEN=... npm run clear-dsc -- --category distress
 *
 * Options:
 *   --host <host>      SignalK HTTP host (default: naturalaspi.local)
 *   --port <port>      SignalK HTTP port (default: 3000)
 *   --category <cat>   distress | urgency | safety | all (default: distress)
 *   --token <jwt>      Readwrite token (default: $SIGNALK_TOKEN)
 *
 * Examples:
 *   node scripts/clear-dsc-alarm.js
 *   node scripts/clear-dsc-alarm.js --category all
 *   node scripts/clear-dsc-alarm.js --host localhost --category urgency
 */

const http = require('node:http');

const CATEGORIES = ['distress', 'urgency', 'safety'];

function parseArgs(argv) {
  const args = {
    host: 'naturalaspi.local',
    port: 3000,
    category: 'distress',
    token: process.env.SIGNALK_TOKEN || '',
  };
  // Flag/value pairs; unknown or valueless flags are silently ignored.
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], val = argv[i + 1];
    if (flag === '--host')     args.host = val;
    if (flag === '--port')     args.port = Number(val);
    if (flag === '--category') args.category = val;
    if (flag === '--token')    args.token = val;
  }
  return args;
}

function clear(category, { host, port, token }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ value: null });
    // Clearing goes through the SignalK REST API (HTTP :3000), not the UDP
    // injection port the send-test-dsc script uses — it is an authed write.
    const req = http.request(
      {
        host,
        port,
        method: 'PUT',
        path: `/signalk/v1/api/vessels/self/notifications/dsc/${category}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.category !== 'all' && !CATEGORIES.includes(args.category)) {
    console.error(`Unknown category "${args.category}". Valid: ${CATEGORIES.join(', ')}, all`);
    process.exit(1);
  }
  if (!args.token) {
    console.error('No token. Pass --token <jwt> or set SIGNALK_TOKEN (a readwrite token).');
    process.exit(1);
  }

  const targets = args.category === 'all' ? CATEGORIES : [args.category];
  let failed = false;
  for (const category of targets) {
    const { status, body } = await clear(category, args);
    const ok = status >= 200 && status < 300;
    console.log(`${ok ? 'cleared' : 'FAILED'} ${category} → HTTP ${status} ${body}`);
    if (!ok) failed = true;
  }
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
