# DSCWatch Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in submission of every received DSC call (repeats and DSE refinements included) to DSCWatch.com through a persistent write-through queue.

**Architecture:** A generic, service-agnostic HTTP reporter with a JSONL queue lands in `@sailingnaturali/signalk-distress-core` (`lib/reporter.js`); `signalk-dsc` gains a pure payload builder (`lib/dscwatch.js`) and wires reporting in *before* its local store dedupe so every radio repeat gets its own POST. Spec: `docs/superpowers/specs/2026-07-09-dscwatch-reporting-design.md`.

**Tech Stack:** Node ≥18 CommonJS, zero runtime deps, `node --test` + `node:assert/strict`, synchronous JSONL persistence (matches `EventStore`), global `fetch` with `fetchImpl` injection for tests.

## Global Constraints

- Reporting is opt-in: `dscwatchEnabled` defaults to `false`; disabled = reporter never constructed.
- `report()` never throws and never blocks the alarm/store/logbook path.
- No client-side dedupe: every repeat and every DSE refinement is its own POST. `receivedAt` is the true receive time, never rewritten.
- Queue is write-through: `report()` appends then immediately kicks the flusher; sequential in-order delivery.
- Response policy: `2xx` dequeue; `400`/`404` dequeue+log (404 also `onPermanentError`, signaled once until a success); network error keep indefinitely with backoff (cap 5 min); `5xx` retry capped at 10 attempts per entry then drop.
- Receiver key: blank config → lowercase UUID persisted at `<dataDir>/dscwatch-receiver-key`.
- Both repos: `'use strict'`, CommonJS, file style mirrors existing `lib/` modules; tests mirror existing `test/*.test.js` style.
- Versions: distress-core `0.4.0 → 0.5.0`, signalk-dsc `0.5.7 → 0.6.0` (dep bump to `^0.5.0`).
- Release notes are outbound text: **draft for Bryan's review, publish only on explicit go.**
- **Never enable `dscwatchEnabled` on the Pi during Phase 0** — the vessel is fully mocked; enabling it would submit fake DSC traffic to the real service. Live smoke tests use the `dscwatchUrl` override against a local capture server.

---

## Repo 1: `~/src/sailingnaturali/signalk-distress-core`

### Task 1: Reporter happy path (write-through queue, 2xx dequeue)

**Files:**
- Create: `lib/reporter.js`
- Test: `test/reporter.test.js`

**Interfaces:**
- Produces: `createReporter({ url, userAgent, queueFile, maxQueue = 5000, maxAttempts = 10, backoffBaseMs = 1000, backoffMaxMs = 300000, log = () => {}, onPermanentError = () => {}, fetchImpl = fetch })` → `{ report(payload), start(), stop() }`. Queue file is JSONL, one payload per line. Later tasks extend this same module.

- [ ] **Step 1: Write the failing tests**

Create `test/reporter.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReporter } = require('../lib/reporter');

function tmpQueue() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-')), 'queue.jsonl');
}

// Poll until the assertions inside `fn` pass — delivery is async fire-behind.
async function eventually(fn, timeout = 1000) {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** fetch stand-in: records calls, answers from a scriptable handler. */
function mockFetch(handler = () => ({ ok: true, status: 201 })) {
  const calls = [];
  const impl = async (url, opts) => {
    const call = { url, opts, body: JSON.parse(opts.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { impl, calls };
}

test('report() POSTs immediately with headers, then dequeues on 2xx', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch();
  const reporter = createReporter({
    url: 'https://x.test/api/v1/report/key-1',
    userAgent: 'test-client/1.0',
    queueFile,
    fetchImpl: impl,
  });
  reporter.start();
  reporter.report({ category: 'distress', mmsi: '244223600' });

  await eventually(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://x.test/api/v1/report/key-1');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].opts.headers['User-Agent'], 'test-client/1.0');
    assert.equal(calls[0].body.mmsi, '244223600');
    // Dequeued: nothing left on disk.
    assert.equal(fs.readFileSync(queueFile, 'utf8').trim(), '');
  });
  reporter.stop();
});

test('200 (merged) and 201 (created) are both accepted', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch((call, n) => ({ ok: true, status: n === 1 ? 201 : 200 }));
  const reporter = createReporter({ url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl });
  reporter.start();
  reporter.report({ n: 1 });
  reporter.report({ n: 2 });
  await eventually(() => {
    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(queueFile, 'utf8').trim(), '');
  });
  reporter.stop();
});

test('delivery is sequential and in submission order', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch();
  const reporter = createReporter({ url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl });
  reporter.start();
  for (let i = 0; i < 5; i++) reporter.report({ seq: i });
  await eventually(() => {
    assert.deepEqual(calls.map((c) => c.body.seq), [0, 1, 2, 3, 4]);
  });
  reporter.stop();
});

test('reports enqueued before start() flush on start()', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch();
  const reporter = createReporter({ url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl });
  reporter.report({ early: true }); // not started yet: queued, not sent
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0);
  reporter.start();
  await eventually(() => assert.equal(calls.length, 1));
  reporter.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/src/sailingnaturali/signalk-distress-core && node --test test/reporter.test.js`
Expected: FAIL — `Cannot find module '../lib/reporter'`

- [ ] **Step 3: Write the implementation**

Create `lib/reporter.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * Generic "deliver JSON payloads to an HTTP endpoint through a persistent
 * queue" module. Payloads are opaque — no DSC (or any service) semantics
 * here; signalk-dsc maps its events onto DSCWatch bodies before calling
 * report(), and signalk-ais-distress can reuse this as-is.
 *
 * Write-through, not batching: report() appends to the JSONL queue and
 * immediately kicks the flusher, so a healthy network sees the POST within
 * milliseconds. The append-before-POST ordering is crash-safety — a report
 * survives the process dying mid-flight. Delivery is sequential and in
 * order so position refinements follow the alerts they refine.
 */
function createReporter({
  url,
  userAgent,
  queueFile,
  maxQueue = 5000,
  maxAttempts = 10,
  backoffBaseMs = 1000,
  backoffMaxMs = 5 * 60 * 1000,
  log = () => {},
  onPermanentError = () => {},
  fetchImpl = fetch,
}) {
  let queue = []; // { payload, attempts } — attempts is in-memory only
  let started = false;
  let flushing = false;
  let timer = null;
  let backoffMs = backoffBaseMs;
  let permanentSignaled = false;

  try {
    for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        queue.push({ payload: JSON.parse(line), attempts: 0 });
      } catch {
        // torn/corrupt line — skip it, keep the rest
      }
    }
  } catch {
    // no queue yet
  }

  function persist() {
    const tmp = `${queueFile}.tmp`;
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(tmp, queue.map((e) => JSON.stringify(e.payload)).join('\n') + '\n');
    fs.renameSync(tmp, queueFile);
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, ms);
    if (timer.unref) timer.unref();
  }

  function backoff() {
    schedule(backoffMs);
    backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
  }

  async function flush() {
    if (!started || flushing) return;
    flushing = true;
    try {
      while (started && queue.length) {
        const entry = queue[0];
        let res;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
            body: JSON.stringify(entry.payload),
          });
        } catch (err) {
          // Network down (the offline-passage case): keep everything —
          // whatever is behind the head is failing for the same reason,
          // so in-order blocking costs nothing. Retry on a growing timer.
          log(`reporter: network error (${err.message}) — ${queue.length} queued`);
          backoff();
          return;
        }
        if (res.ok) {
          queue.shift();
          persist();
          backoffMs = backoffBaseMs;
          permanentSignaled = false;
          continue;
        }
        if (res.status === 400 || res.status === 404) {
          // A retry cannot fix a bad body or a rejected receiver key.
          queue.shift();
          persist();
          log(`reporter: dropped report (HTTP ${res.status})`);
          if (res.status === 404 && !permanentSignaled) {
            permanentSignaled = true;
            onPermanentError(res.status);
          }
          continue;
        }
        // Server reachable but erroring (5xx): retry with backoff, but cap
        // per entry — one poison payload must not block the queue behind it.
        entry.attempts += 1;
        if (entry.attempts >= maxAttempts) {
          queue.shift();
          persist();
          log(`reporter: dropped report after ${maxAttempts} attempts (HTTP ${res.status})`);
          continue;
        }
        backoff();
        return;
      }
    } catch (err) {
      log(`reporter: flush failed: ${err.message}`);
    } finally {
      flushing = false;
    }
  }

  return {
    /** Enqueue and kick the flusher. Fire-behind: never throws. */
    report(payload) {
      try {
        queue.push({ payload, attempts: 0 });
        if (queue.length > maxQueue) {
          queue = queue.slice(-maxQueue);
          persist();
        } else {
          fs.mkdirSync(path.dirname(queueFile), { recursive: true });
          fs.appendFileSync(queueFile, JSON.stringify(payload) + '\n');
        }
        flush();
      } catch (err) {
        log(`reporter: enqueue failed: ${err.message}`);
      }
    },
    start() {
      started = true;
      flush();
    },
    stop() {
      started = false;
      clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createReporter };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/reporter.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: all existing tests still pass.

```bash
git add lib/reporter.js test/reporter.test.js
git commit -m "feat: generic persistent-queue HTTP reporter (write-through, in-order)"
```

---

### Task 2: Reporter response policy (drops, retry caps, backoff)

**Files:**
- Modify: `lib/reporter.js` (only if a test exposes a gap — the Task 1 code already implements this policy; these tests pin it)
- Test: `test/reporter.test.js` (append)

**Interfaces:**
- Consumes: `createReporter` from Task 1, including `maxAttempts`, `backoffBaseMs`, `onPermanentError`, `log`.
- Produces: the exact response-policy behavior later tasks and the spec rely on.

- [ ] **Step 1: Write the failing/pinning tests**

Append to `test/reporter.test.js`:

```js
test('400 is dropped without retry; the next report still delivers', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch((call) =>
    call.body.bad ? { ok: false, status: 400 } : { ok: true, status: 201 }
  );
  const dropped = [];
  const reporter = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl,
    log: (m) => dropped.push(m),
  });
  reporter.start();
  reporter.report({ bad: true });
  reporter.report({ good: true });
  await eventually(() => {
    assert.equal(calls.length, 2); // bad tried exactly once
    assert.equal(calls[1].body.good, true);
    assert.ok(dropped.some((m) => /HTTP 400/.test(m)));
  });
  reporter.stop();
});

test('404 drops and signals onPermanentError once until a success resets it', async () => {
  const queueFile = tmpQueue();
  let mode = 404;
  const { impl, calls } = mockFetch(() =>
    mode === 404 ? { ok: false, status: 404 } : { ok: true, status: 200 }
  );
  const signals = [];
  const reporter = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl,
    onPermanentError: (status) => signals.push(status),
  });
  reporter.start();
  reporter.report({ n: 1 });
  reporter.report({ n: 2 });
  await eventually(() => assert.equal(calls.length, 2));
  assert.deepEqual(signals, [404]); // two drops, one signal — no spam

  mode = 200;
  reporter.report({ n: 3 }); // success resets the once-guard
  await eventually(() => assert.equal(calls.length, 3));
  mode = 404;
  reporter.report({ n: 4 });
  await eventually(() => assert.deepEqual(signals, [404, 404]));
  reporter.stop();
});

test('network error keeps the entry; delivery resumes when fetch recovers', async () => {
  const queueFile = tmpQueue();
  let online = false;
  const { impl, calls } = mockFetch(() => {
    if (!online) throw new Error('ECONNREFUSED');
    return { ok: true, status: 201 };
  });
  const reporter = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl, backoffBaseMs: 10,
  });
  reporter.start();
  reporter.report({ seq: 0 });
  reporter.report({ seq: 1 });
  await eventually(() => assert.ok(calls.length >= 1)); // tried and failed
  const failedTries = calls.length;
  online = true;
  await eventually(() => {
    // Everything delivered, in order, nothing dropped by the outage.
    const delivered = calls.slice(failedTries).map((c) => c.body.seq);
    assert.deepEqual(delivered, [0, 1]);
    assert.equal(fs.readFileSync(queueFile, 'utf8').trim(), '');
  });
  reporter.stop();
});

test('5xx retries are capped per entry, then the entry drops and the queue moves on', async () => {
  const queueFile = tmpQueue();
  const { impl, calls } = mockFetch((call) =>
    call.body.poison ? { ok: false, status: 500 } : { ok: true, status: 201 }
  );
  const reporter = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl,
    maxAttempts: 3, backoffBaseMs: 5, backoffMaxMs: 10,
  });
  reporter.start();
  reporter.report({ poison: true });
  reporter.report({ after: true });
  await eventually(() => {
    const poisonTries = calls.filter((c) => c.body.poison).length;
    assert.equal(poisonTries, 3); // exactly maxAttempts, then dropped
    assert.equal(calls[calls.length - 1].body.after, true);
  });
  reporter.stop();
});
```

- [ ] **Step 2: Run tests**

Run: `node --test test/reporter.test.js`
Expected: PASS if Task 1's implementation is complete; if any test fails, fix `lib/reporter.js` until the policy matches (the policy is the spec — do not weaken a test to pass).

- [ ] **Step 3: Commit**

```bash
git add test/reporter.test.js lib/reporter.js
git commit -m "test: pin reporter response policy (400/404 drop, 5xx cap, offline catch-up)"
```

---

### Task 3: Queue persistence across restart + maxQueue trim

**Files:**
- Modify: `lib/reporter.js` (only if a test exposes a gap)
- Test: `test/reporter.test.js` (append)

**Interfaces:**
- Consumes: `createReporter` from Tasks 1–2.
- Produces: restart-survivable queue semantics the plugin relies on.

- [ ] **Step 1: Write the tests**

Append to `test/reporter.test.js`:

```js
test('undelivered reports survive a restart and flush in order', async () => {
  const queueFile = tmpQueue();
  const offline = mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const first = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: offline.impl, backoffBaseMs: 5,
  });
  first.start();
  first.report({ seq: 0 });
  first.report({ seq: 1 });
  await eventually(() => assert.ok(offline.calls.length >= 1));
  first.stop(); // "process exit" — queue stays on disk

  const online = mockFetch();
  const second = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: online.impl,
  });
  second.start();
  await eventually(() => {
    assert.deepEqual(online.calls.map((c) => c.body.seq), [0, 1]);
    assert.equal(fs.readFileSync(queueFile, 'utf8').trim(), '');
  });
  second.stop();
});

test('a torn queue line is skipped; the rest of the queue still delivers', async () => {
  const queueFile = tmpQueue();
  fs.writeFileSync(queueFile, `${JSON.stringify({ seq: 0 })}\n{"seq": 1, "torn\n${JSON.stringify({ seq: 2 })}\n`);
  const { impl, calls } = mockFetch();
  const reporter = createReporter({ url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl });
  reporter.start();
  await eventually(() => assert.deepEqual(calls.map((c) => c.body.seq), [0, 2]));
  reporter.stop();
});

test('maxQueue caps growth by dropping oldest', async () => {
  const queueFile = tmpQueue();
  const { impl } = mockFetch(() => {
    throw new Error('offline');
  });
  const reporter = createReporter({
    url: 'u', userAgent: 'ua', queueFile, fetchImpl: impl, maxQueue: 3, backoffBaseMs: 60000,
  });
  reporter.start();
  for (let i = 0; i < 5; i++) reporter.report({ seq: i });
  await eventually(() => {
    const lines = fs.readFileSync(queueFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
    assert.deepEqual(lines, [2, 3, 4]);
  });
  reporter.stop();
});
```

- [ ] **Step 2: Run tests**

Run: `node --test test/reporter.test.js`
Expected: PASS (fix `lib/reporter.js` if not — same rule as Task 2).

- [ ] **Step 3: Commit**

```bash
git add test/reporter.test.js lib/reporter.js
git commit -m "test: queue persistence across restart, torn-line skip, maxQueue trim"
```

---

### Task 4: Receiver-key helper

**Files:**
- Modify: `lib/reporter.js`
- Test: `test/reporter.test.js` (append)

**Interfaces:**
- Produces: `loadOrCreateReceiverKey(filePath)` → string. Reads a persisted key, or generates a lowercase UUID, writes it, and returns it. Exported from `lib/reporter.js` alongside `createReporter`.

- [ ] **Step 1: Write the failing test**

Append to `test/reporter.test.js` (add `loadOrCreateReceiverKey` to the require at the top):

```js
const { createReporter, loadOrCreateReceiverKey } = require('../lib/reporter');
```

```js
test('loadOrCreateReceiverKey mints a lowercase UUID once and reuses it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rk-')), 'dscwatch-receiver-key');
  const key = loadOrCreateReceiverKey(file);
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(loadOrCreateReceiverKey(file), key); // stable across calls
  assert.equal(fs.readFileSync(file, 'utf8').trim(), key); // persisted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reporter.test.js`
Expected: FAIL — `loadOrCreateReceiverKey is not a function`

- [ ] **Step 3: Implement**

In `lib/reporter.js`, add `const crypto = require('node:crypto');` to the requires, and above `createReporter`:

```js
/** Read the persisted receiver key, or mint a lowercase UUID once and keep it.
 *  DSCWatch has no registration call: the first report for a new key creates
 *  the receiver record, so the only rule is "reuse the same value forever". */
function loadOrCreateReceiverKey(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // no key yet
  }
  const key = crypto.randomUUID();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, key + '\n');
  return key;
}
```

Update the export: `module.exports = { createReporter, loadOrCreateReceiverKey };`

- [ ] **Step 4: Run tests, commit**

Run: `npm test` — expected: PASS.

```bash
git add lib/reporter.js test/reporter.test.js
git commit -m "feat: persisted receiver-key helper"
```

---

### Task 5: Export, docs, release core 0.5.0

**Files:**
- Modify: `index.js`, `test/public-api.test.js`, `README.md`, `CHANGELOG.md`, `package.json`

**Interfaces:**
- Produces: `createReporter` and `loadOrCreateReceiverKey` on the package's public API — signalk-dsc imports them from `@sailingnaturali/signalk-distress-core` in Task 7.

- [ ] **Step 1: Failing public-api test**

`test/public-api.test.js` loops over an expected-names array. Add `'createReporter', 'loadOrCreateReceiverKey',` as a new line in that array (after the `'captureOwnShip', 'buildObservations',` line).

Run: `node --test test/public-api.test.js` — expected: FAIL.

- [ ] **Step 2: Export**

In `index.js`, add:

```js
const { createReporter, loadOrCreateReceiverKey } = require('./lib/reporter');
```

and add `createReporter, loadOrCreateReceiverKey,` to the `module.exports` object.

Run: `npm test` — expected: PASS.

- [ ] **Step 3: Docs + version**

- `README.md`: add a bullet for the reporter to the module list, matching existing tone, e.g. *"`reporter` — generic persistent-queue HTTP reporter (write-through JSONL queue, offline catch-up, per-entry retry caps) for submitting received events to services like DSCWatch.com"*. Keep it ≤3 lines.
- `CHANGELOG.md`: add a `## 0.5.0` section: `Added: createReporter / loadOrCreateReceiverKey — generic persistent-queue HTTP reporter for event submission (DSCWatch et al.).`
- `package.json`: `"version": "0.5.0"`.

- [ ] **Step 4: Full verification, commit**

Run: `npm test`
Expected: all pass.

```bash
git add -A && git status   # confirm only intended files staged
git commit -m "chore(release): v0.5.0 — persistent-queue HTTP reporter"
git push
```

- [ ] **Step 5: Release — STOP for review**

Draft the `gh release create v0.5.0` notes in a copy-pasteable block and **stop for Bryan's explicit go** (release notes are outbound text). On go, follow the `publish-signalk-plugin` skill (release creation auto-publishes to npm via OIDC). Verify afterward: `npm view @sailingnaturali/signalk-distress-core version` → `0.5.0`.

---

## Repo 2: `~/src/sailingnaturali/signalk-dsc`

### Task 6: DSCWatch payload builder

**Files:**
- Create: `lib/dscwatch.js`
- Test: `test/dscwatch.test.js`
- Dev setup: link the unreleased core so tests run before 0.5.0 is on npm:
  `cd ~/src/sailingnaturali/signalk-dsc && npm install --no-save ../signalk-distress-core`
  (Task 7's tests need the reporter; harmless to do now. `--no-save` keeps package.json clean.)

**Interfaces:**
- Consumes: the normalized event shape produced by `parseDsc` / `normalizePgn129808` / `record()` (fields: `receivedAt`, `source`, `format`, `category`, `mmsi`, `raw`, `position`, `positionResolution`, `utcTime`, `natureOfDistress`, `relay`, `distressedMmsi`, `deviceBeacon`, `workingChannel`, `acknowledgement`, `expansion`, `self`, plus local-only `id`/`message`/`repeats`/`lastReceivedAt`/`ownShip`/`clearedAt`).
- Produces: `buildReport(event, { ownPosition } = {})` → plain object, the DSCWatch POST body. Task 7 calls this.

- [ ] **Step 1: Write the failing tests**

Create `test/dscwatch.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReport } = require('../lib/dscwatch');

// Golden test: the DSCWatch spec's distress-alert example, from an event
// shaped exactly as record() stores it (plus local-only fields that must
// never leak off the boat).
test('distress alert maps to the DSCWatch example body', () => {
  const event = {
    id: '2026-06-30T14:23:07.812Z-244223600',           // local-only
    message: 'Mayday relay…',                            // local-only
    repeats: 2,                                          // local-only
    ownShip: { position: { latitude: 48.4, longitude: 3.1 }, sog: 3.2 }, // local-only
    receivedAt: '2026-06-30T14:23:07.812Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.7833, longitude: 3.45 },
    positionResolution: 'minute',
    utcTime: '14:23',
    expansion: true,
    raw: '$CDDSC,12,2442236000,12,05,00,0484700327,1423,,,,E*5A',
  };
  const body = buildReport(event, { ownPosition: { latitude: 48.4, longitude: 3.1 } });
  assert.deepEqual(body, {
    receivedAt: '2026-06-30T14:23:07.812Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.7833, longitude: 3.45 },
    positionResolution: 'minute',
    utcTime: '14:23',
    expansion: true,
    ownPosition: { latitude: 48.4, longitude: 3.1 },
    raw: '$CDDSC,12,2442236000,12,05,00,0484700327,1423,,,,E*5A',
  });
});

// Golden test: the spec's DSE refinement example.
test('DSE refinement maps to the DSCWatch refinement body', () => {
  const event = {
    receivedAt: '2026-06-30T14:23:11.004Z',
    source: 'nmea0183',
    format: 'distressAlert',
    category: 'distress',
    mmsi: '244223600',
    natureOfDistress: 'sinking',
    position: { latitude: 48.78411, longitude: 3.45219 },
    positionResolution: 'enhanced',
    positionRefined: true,
    expansion: true, // from the original call — flag rides along, fine
    raw: '$CDDSE,1,1,A,2442236000,00,4807.846,00320.131*4F',
  };
  const body = buildReport(event, {});
  assert.equal(body.positionRefined, true);
  assert.equal(body.positionResolution, 'enhanced');
  assert.equal(body.raw, '$CDDSE,1,1,A,2442236000,00,4807.846,00320.131*4F');
  assert.equal('ownPosition' in body, false); // no GPS fix → omitted
});

test('boolean flags appear only when true; absent fields are omitted', () => {
  const body = buildReport({
    receivedAt: 't', source: 'nmea0183', category: 'routine', format: 'individual',
    raw: '$CDDSC,…', mmsi: '338158137', workingChannel: '72',
    expansion: false, // parseDsc always sets it; false must not be sent
  });
  assert.equal('expansion' in body, false);
  assert.equal('self' in body, false);
  assert.equal('relay' in body, false);
  assert.equal('position' in body, false);
  assert.equal(body.workingChannel, '72');
});

test('n2k events keep the PGN fields object as raw and default format', () => {
  const body = buildReport({
    receivedAt: 't', source: 'n2k', category: 'urgency',
    raw: { dscFormat: 'All ships', dscCategory: 'Urgency' },
  });
  assert.deepEqual(body.raw, { dscFormat: 'All ships', dscCategory: 'Urgency' });
  assert.equal(body.format, 'unknown'); // required by the API; never absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/dscwatch.test.js`
Expected: FAIL — `Cannot find module '../lib/dscwatch'`

- [ ] **Step 3: Implement**

Create `lib/dscwatch.js`:

```js
'use strict';

/*
 * Map a normalized DSC event onto a DSCWatch report body
 * (POST https://dscwatch.com/api/v1/report/<receiver-key>).
 *
 * Pure field-picker: send what we have, omit what we don't. The pick-list is
 * also the privacy boundary — local-only fields (id, message, repeats,
 * lastReceivedAt, ownShip, clearedAt) are never sent because they are never
 * picked. Boolean flags go out only when true; parseDsc always materializes
 * `expansion` as false and the API treats absence as false.
 */

const FIELDS = [
  'receivedAt',
  'source',
  'category',
  'format',
  'raw',
  'mmsi',
  'position',
  'positionResolution',
  'utcTime',
  'natureOfDistress',
  'distressedMmsi',
  'deviceBeacon',
  'workingChannel',
  'acknowledgement',
];

const FLAGS = ['relay', 'expansion', 'self', 'positionRefined'];

function buildReport(event, { ownPosition } = {}) {
  const body = {};
  for (const key of FIELDS) {
    if (event[key] !== undefined) body[key] = event[key];
  }
  for (const key of FLAGS) {
    if (event[key] === true) body[key] = true;
  }
  if (!body.format) body.format = 'unknown';
  if (ownPosition && typeof ownPosition.latitude === 'number') {
    body.ownPosition = { latitude: ownPosition.latitude, longitude: ownPosition.longitude };
  }
  return body;
}

module.exports = { buildReport };
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/dscwatch.test.js` — expected: PASS.
Run: `npm test` — expected: all pass.

```bash
git add lib/dscwatch.js test/dscwatch.test.js
git commit -m "feat: DSCWatch payload builder (pure field-picker over the normalized event)"
```

---

### Task 7: Plugin wiring — config, hooks, lifecycle

**Files:**
- Modify: `index.js`
- Test: `test/plugin.test.js` (append)

**Interfaces:**
- Consumes: `buildReport` (Task 6); `createReporter`, `loadOrCreateReceiverKey` from `@sailingnaturali/signalk-distress-core` (Task 5, linked locally).
- Produces: config options `dscwatchEnabled` (bool, default false), `dscwatchReceiverKey` (string, default `''`), `dscwatchUrl` (string, default `https://dscwatch.com/api/v1/report`); files `<dataDir>/dscwatch-queue.jsonl` and `<dataDir>/dscwatch-receiver-key`.

- [ ] **Step 1: Write the failing integration tests**

Append to `test/plugin.test.js`. First add a multi-request capture server helper next to `logbookServer()`:

```js
// DSCWatch stand-in: collects every POST, answers 201 like the real API.
function dscwatchServer() {
  const requests = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', id: requests.length, created: true }));
      for (const w of [...waiters]) w();
    });
  });
  // Resolves once `count` requests have arrived.
  const until = (count) =>
    new Promise((resolve) => {
      const check = () => {
        if (requests.length >= count) resolve(requests.slice(0, count));
      };
      waiters.push(check);
      check();
    });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, requests, until, port: server.address().port }))
  );
}
```

Then the tests:

```js
test('DSCWatch: disabled by default — no reports leave the boat', async () => {
  const { server, requests, port } = await dscwatchServer();
  const app = mockApp();
  const plugin = start(app, { dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report` });
  app.parsers.DSC(sentenceInput(DISTRESS));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(requests.length, 0);
  server.close();
  plugin.stop();
});

test('DSCWatch: a distress alert is reported with a persisted UUID receiver key', async () => {
  const { server, until, port } = await dscwatchServer();
  const app = mockApp();
  const plugin = start(app, {
    dscwatchEnabled: true,
    dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report`,
  });
  app.parsers.DSC(sentenceInput(DISTRESS));

  const [req] = await until(1);
  const key = req.url.split('/').pop();
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal(
    fs.readFileSync(path.join(app.dataDir, 'dscwatch-receiver-key'), 'utf8').trim(),
    key
  );
  assert.match(req.headers['user-agent'], /^signalk-dsc\//);
  assert.equal(req.body.category, 'distress');
  assert.equal(req.body.mmsi, '338040079');
  assert.equal(req.body.natureOfDistress, 'sinking');
  assert.equal(req.body.raw, DISTRESS);
  // Local-only fields never leave the boat.
  assert.equal('message' in req.body, false);
  assert.equal('ownShip' in req.body, false);
  server.close();
  plugin.stop();
});

test('DSCWatch: a configured receiver key (MMSI) is used verbatim', async () => {
  const { server, until, port } = await dscwatchServer();
  const app = mockApp();
  const plugin = start(app, {
    dscwatchEnabled: true,
    dscwatchReceiverKey: '368000001',
    dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report`,
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  const [req] = await until(1);
  assert.equal(req.url, '/api/v1/report/368000001');
  server.close();
  plugin.stop();
});

test('DSCWatch: repeats are POSTed even though the store dedupes them', async () => {
  const { server, until, port } = await dscwatchServer();
  const app = mockApp();
  const plugin = start(app, {
    dscwatchEnabled: true,
    dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report`,
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  app.parsers.DSC(sentenceInput(DISTRESS)); // re-transmission

  const reqs = await until(2);
  assert.equal(reqs[0].body.mmsi, reqs[1].body.mmsi);
  // Local store still deduped to one event with one alarm.
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(app.deltas.length, 1);
  server.close();
  plugin.stop();
});

test('DSCWatch: a DSE refinement is its own POST with positionRefined', async () => {
  const { server, until, port } = await dscwatchServer();
  const app = mockApp();
  const plugin = start(app, {
    dscwatchEnabled: true,
    dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report`,
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  app.parsers.DSE(sentenceInput(DSE));

  const reqs = await until(2);
  const refinement = reqs[1].body;
  assert.equal(refinement.positionRefined, true);
  assert.equal(refinement.positionResolution, 'enhanced');
  assert.equal(refinement.raw, DSE); // the DSE sentence, not the original DSC
  assert.equal(refinement.mmsi, '338040079');
  assert.ok(Math.abs(refinement.position.latitude - (42 + 31.4589 / 60)) < 1e-9);
  server.close();
  plugin.stop();
});

test('DSCWatch: ownPosition rides along when the receiver has a fix; self flag on own calls', async () => {
  const { server, until, port } = await dscwatchServer();
  const app = mockApp();
  app.getSelfPath = (p) => {
    if (p === 'mmsi') return '338040079'; // the DISTRESS sentence's own MMSI
    if (p === 'navigation.position') return { value: { latitude: 48.76, longitude: -123.23 } };
    return undefined;
  };
  const plugin = start(app, {
    dscwatchEnabled: true,
    dscwatchUrl: `http://127.0.0.1:${port}/api/v1/report`,
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  const [req] = await until(1);
  assert.deepEqual(req.body.ownPosition, { latitude: 48.76, longitude: -123.23 });
  assert.equal(req.body.self, true);
  server.close();
  plugin.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: the six new `DSCWatch:` tests FAIL (timeouts/`requests.length` 0); all pre-existing tests still PASS.

- [ ] **Step 3: Wire the plugin**

In `index.js`:

**(a)** Requires — add after the existing distress-core destructure:

```js
const { buildReport } = require('./lib/dscwatch');
const { version } = require('./package.json');
```

and add `createReporter, loadOrCreateReceiverKey,` to the existing `require('@sailingnaturali/signalk-distress-core')` destructure.

**(b)** Schema — add to `plugin.schema.properties` after `snapshotPaths`:

```js
dscwatchEnabled: {
  type: 'boolean',
  title: 'Report received calls to DSCWatch.com',
  description:
    'Opt-in: submit every received DSC call — including your receiver position — to the DSCWatch crowdsourced receiver network. Undelivered reports queue on disk and catch up when connectivity returns.',
  default: false,
},
dscwatchReceiverKey: {
  type: 'string',
  title: 'DSCWatch receiver key',
  description:
    'Leave blank to use an auto-generated station UUID (persisted in the plugin data directory), or enter this station\'s 9-digit MMSI for attribution.',
  default: '',
},
dscwatchUrl: {
  type: 'string',
  title: 'DSCWatch endpoint',
  description: 'Base report URL; the receiver key is appended. Override for testing only.',
  default: 'https://dscwatch.com/api/v1/report',
},
```

**(c)** State — next to `let store = null;`:

```js
let reporter = null;
```

**(d)** Reporting helper — after `messageContext()`:

```js
// Fire-behind submission to DSCWatch (crowdsourced DSC receiver network).
// Called before/independent of the store dedupe: the API wants every radio
// repeat and every DSE refinement as its own POST — the backend dedupes.
function reportToDscwatch(event, extra) {
  if (!reporter) return;
  reporter.report(buildReport({ ...event, ...extra }, { ownPosition: selfPosition() }));
}
```

**(e)** Hook `record()` — insert immediately after the `event.self` line, before the `store.findRecent` dedupe lookup:

```js
    if (event.mmsi && event.mmsi === selfMmsi()) event.self = true;

    reportToDscwatch(event);
```

**(f)** Hook `dseParser()` — after the `store.update(target.id, …)` line (target now carries the refined position and `'enhanced'` resolution):

```js
      store.update(target.id, { position: refined, positionResolution: 'enhanced' });
      reportToDscwatch(target, {
        receivedAt: new Date(now).toISOString(),
        raw: input.sentence,
        positionRefined: true,
      });
```

**(g)** Lifecycle — in `plugin.start`, add the three defaults to the `options` spread (`dscwatchEnabled: false, dscwatchReceiverKey: '', dscwatchUrl: 'https://dscwatch.com/api/v1/report',` before `...opts`), then after the `store = new EventStore(…)` block:

```js
    if (options.dscwatchEnabled) {
      const receiverKey =
        options.dscwatchReceiverKey.trim() ||
        loadOrCreateReceiverKey(path.join(app.getDataDirPath(), 'dscwatch-receiver-key'));
      reporter = createReporter({
        url: `${options.dscwatchUrl.replace(/\/+$/, '')}/${receiverKey}`,
        userAgent: `signalk-dsc/${version}`,
        queueFile: path.join(app.getDataDirPath(), 'dscwatch-queue.jsonl'),
        log: (msg) => app.debug(msg),
        onPermanentError: (status) =>
          app.setPluginStatus(`DSCWatch: receiver key rejected (HTTP ${status}) — check configuration`),
      });
      reporter.start();
    }
```

and in `plugin.stop`:

```js
    if (reporter) {
      reporter.stop();
      reporter = null;
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass, including all pre-existing ones (the disabled-by-default test doubles as the no-regression guard).

- [ ] **Step 5: Commit**

```bash
git add index.js test/plugin.test.js
git commit -m "feat: opt-in DSCWatch reporting (every repeat + DSE refinement, offline catch-up queue)"
```

---

### Task 8: Docs, dep bump, release dsc 0.6.0

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: published `@sailingnaturali/signalk-distress-core@0.5.0` (Task 5's release must be live on npm first — this task blocks on it).

- [ ] **Step 1: Swap the linked core for the published release**

```bash
cd ~/src/sailingnaturali/signalk-dsc
npm install @sailingnaturali/signalk-distress-core@^0.5.0
npm test
```

Expected: `package.json` dep reads `"^0.5.0"`, all tests pass against the published package.

- [ ] **Step 2: Docs**

- `README.md`: add a "DSCWatch reporting" section documenting the three config options, the opt-in default, what leaves the boat (call fields + receiver position; never `ownShip` snapshots or spoken messages), the persistent offline catch-up queue, and the receiver-key file location. Technical content only — no internal milestones. If a "why" paragraph grows past 8 lines, condense and link an engineering.sailingnaturali.com article instead.
- `CHANGELOG.md`: `## 0.6.0 — Added: opt-in DSCWatch.com reporting (dscwatchEnabled) — every received call, repeat, and DSE refinement is submitted through a persistent write-through queue with offline catch-up.`
- `package.json`: `"version": "0.6.0"`.

- [ ] **Step 3: Verify + commit**

Run: `npm test`
Expected: all pass.

```bash
git add README.md CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): v0.6.0 — opt-in DSCWatch reporting"
git push
```

- [ ] **Step 4: Release — STOP for review**

Draft the `gh release create v0.6.0` notes in a copy-pasteable block and **stop for Bryan's explicit go**. On go, release per the `publish-signalk-plugin` skill; verify `npm view @sailingnaturali/signalk-dsc version` → `0.6.0`.

- [ ] **Step 5: Pi upgrade (feature stays OFF)**

Upgrade the installed plugin on the Pi but **do not enable `dscwatchEnabled`** — Phase 0 vessel data is mocked and must never reach the real service:

```bash
ssh naturalaspi 'docker exec signalk sh -c "cd ~/.signalk && npm install @sailingnaturali/signalk-dsc@0.6.0"'
ssh naturalaspi 'cd ~/signalk && docker compose restart signalk'
```

Then confirm the server is healthy and the plugin loaded (Server → Plugin Config shows DSC 0.6.0; no errors in `docker logs signalk --since 2m`).

---

## Self-review notes

- **Spec coverage:** reporter module + delivery semantics (Tasks 1–3), receiver key (Task 4), public API (Task 5), payload builder incl. golden examples (Task 6), config schema / hooks / fire-behind / lifecycle (Task 7), docs + coordinated releases (Tasks 5, 8). Plugin-status-on-404 is wired in Task 7(g) via `onPermanentError`; once-guard tested in Task 2.
- **Type consistency:** `createReporter` options and return shape identical across Tasks 1–3, 5, 7; `buildReport(event, { ownPosition })` identical across Tasks 6–7; receiver-key file name `dscwatch-receiver-key` identical across Tasks 4, 7.
- **Known judgment call:** `expansion: false` (always materialized by `parseDsc`) is deliberately omitted from bodies — flags go out only when `true` (Task 6 test pins this).
