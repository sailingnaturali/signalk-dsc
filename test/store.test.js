'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../lib/store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-store-')), 'dsc-calls.jsonl');
}

test('add, list, get round-trip', () => {
  const store = new EventStore({ filePath: tmpFile() });
  const ev = store.add({ category: 'distress', mmsi: '338040079', receivedAt: '2026-06-06T12:00:00.000Z' });
  assert.ok(ev.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(ev.id).mmsi, '338040079');
});

test('events survive a restart (reload from disk)', () => {
  const file = tmpFile();
  const a = new EventStore({ filePath: file });
  a.add({ category: 'urgency', mmsi: '111111111', receivedAt: '2026-06-06T12:00:00.000Z' });
  a.add({ category: 'distress', mmsi: '222222222', receivedAt: '2026-06-06T12:01:00.000Z' });

  const b = new EventStore({ filePath: file });
  assert.equal(b.list().length, 2);
  assert.equal(b.list()[1].mmsi, '222222222');
});

test('retention keeps only the newest maxEvents across restarts', () => {
  const file = tmpFile();
  const a = new EventStore({ filePath: file, maxEvents: 2 });
  for (let i = 0; i < 5; i++) {
    a.add({ category: 'routine', mmsi: String(i).repeat(9), receivedAt: `2026-06-06T12:0${i}:00.000Z` });
  }
  assert.equal(a.list().length, 2);
  const b = new EventStore({ filePath: file, maxEvents: 2 });
  assert.equal(b.list().length, 2);
  assert.equal(b.list()[1].mmsi, '444444444');
});

test('update persists changes (DSE refinement path)', () => {
  const file = tmpFile();
  const a = new EventStore({ filePath: file });
  const ev = a.add({ category: 'distress', mmsi: '338040079', receivedAt: '2026-06-06T12:00:00.000Z' });
  a.update(ev.id, { position: { latitude: 1, longitude: 2 }, positionResolution: 'enhanced' });

  const b = new EventStore({ filePath: file });
  assert.equal(b.get(ev.id).positionResolution, 'enhanced');
});

test('findRecent locates the newest matching event inside the window', () => {
  const store = new EventStore({ filePath: tmpFile() });
  const old = store.add({ category: 'distress', mmsi: '338040079', receivedAt: '2026-06-06T11:00:00.000Z' });
  const recent = store.add({ category: 'distress', mmsi: '338040079', receivedAt: '2026-06-06T12:00:00.000Z' });
  const found = store.findRecent(
    (e) => e.mmsi === '338040079',
    new Date('2026-06-06T12:01:00.000Z').getTime(),
    5 * 60 * 1000
  );
  assert.equal(found.id, recent.id);
  assert.notEqual(found.id, old.id);
  // Outside the window → nothing.
  assert.equal(
    store.findRecent((e) => e.mmsi === '338040079', new Date('2026-06-06T13:00:00.000Z').getTime(), 60000),
    undefined
  );
});

test('corrupt lines in the log are skipped, not fatal', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"id":"a","mmsi":"111111111","receivedAt":"2026-06-06T12:00:00.000Z"}\nnot json\n');
  const store = new EventStore({ filePath: file });
  assert.equal(store.list().length, 1);
});
