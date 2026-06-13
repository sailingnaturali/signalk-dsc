# DSC Alarm Clearing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable way to clear an active DSC alarm — both the live `notifications.dsc.<category>` and the re-raise-on-restart behavior — exposed as a SignalK PUT handler the plugin registers, plus a thin `clear-dsc` script.

**Architecture:** A PUT handler on each notifying notification path clears the live alarm from the plugin's own source and stamps `clearedAt` on the matching stored events; the startup reannounce loop skips cleared events. A network-only script (`scripts/clear-dsc-alarm.js`) PUTs to that path, mirroring `send-test-dsc.js`.

**Tech Stack:** Node.js (CommonJS), `node:test`, SignalK server-api (`registerPutHandler`, `handleMessage`), append-only JSONL store.

---

## File Structure

- `lib/store.js` — **modify**: add `markCleared(predicate, at)` (single-compaction bulk update).
- `index.js` — **modify**: register PUT handlers for the three notifying categories; clear handler; reannounce guard.
- `scripts/clear-dsc-alarm.js` — **create**: thin HTTP PUT client.
- `package.json` — **modify**: add `clear-dsc` npm script; version bump.
- `test/store.test.js` — **modify**: `markCleared` test.
- `test/plugin.test.js` — **modify**: mock `registerPutHandler`; clear-handler + reannounce-skip tests.
- `README.md`, `CHANGELOG.md` — **modify**: document the capability.

---

## Task 1: `EventStore.markCleared`

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/store.test.js`:

```javascript
test('markCleared stamps clearedAt on matching events and persists', () => {
  const file = tmpFile();
  const a = new EventStore({ filePath: file });
  a.add({ category: 'distress', mmsi: '111111111', receivedAt: '2026-06-06T12:00:00.000Z' });
  a.add({ category: 'urgency',  mmsi: '222222222', receivedAt: '2026-06-06T12:01:00.000Z' });
  a.add({ category: 'distress', mmsi: '333333333', receivedAt: '2026-06-06T12:02:00.000Z' });

  const n = a.markCleared((e) => e.category === 'distress', '2026-06-06T13:00:00.000Z');
  assert.equal(n, 2); // returns count touched

  // In-memory: only distress events stamped.
  assert.equal(a.list().filter((e) => e.clearedAt).length, 2);
  assert.equal(a.list().find((e) => e.category === 'urgency').clearedAt, undefined);

  // Persisted: a reload sees the stamps.
  const b = new EventStore({ filePath: file });
  assert.equal(b.list().filter((e) => e.clearedAt === '2026-06-06T13:00:00.000Z').length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/store.test.js`
Expected: FAIL — `a.markCleared is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/store.js`, add this method to the `EventStore` class (after `update`):

```javascript
  /** Stamp `clearedAt` on every event matching `predicate`. Returns the count
   *  touched. Compacts once regardless of how many matched. */
  markCleared(predicate, at) {
    let touched = 0;
    for (const e of this.events) {
      if (predicate(e)) { e.clearedAt = at; touched += 1; }
    }
    if (touched) this._compact();
    return touched;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/store.test.js`
Expected: PASS (all store tests green).

- [ ] **Step 5: Commit**

```bash
cd ~/src/sailingnaturali/signalk-dsc
git add lib/store.js test/store.test.js
git commit -m "feat(store): markCleared bulk-stamps clearedAt with one compaction"
```

---

## Task 2: Reannounce skips cleared events

**Files:**
- Modify: `index.js` (the reannounce loop, around line 364)
- Test: `test/plugin.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/plugin.test.js` (it already imports `fs`, `path`, `makePlugin`, and has `mockApp`):

```javascript
test('a cleared alert is not re-raised after a restart', async () => {
  const app = mockApp();
  const fresh = new Date().toISOString();
  fs.writeFileSync(
    path.join(app.dataDir, 'dsc-calls.jsonl'),
    JSON.stringify({
      id: `${fresh}-338040079`,
      receivedAt: fresh,
      category: 'distress',
      mmsi: '338040079',
      natureOfDistress: 'sinking',
      clearedAt: fresh, // operator cleared it
    }) + '\n'
  );
  const plugin = makePlugin(app);
  plugin.start({ reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(app.deltas.length, 0); // fresh, but cleared → no re-raise
  plugin.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/plugin.test.js`
Expected: FAIL — `app.deltas.length` is 1 (the event is fresh and currently re-raised despite `clearedAt`).

- [ ] **Step 3: Write minimal implementation**

In `index.js`, in the reannounce loop body (inside `reannounceTimer = setTimeout(...)`), add a guard immediately after the existing `if (!NOTIFICATION_STATES[event.category] || reannounced.has(event.category)) continue;` line:

```javascript
        if (event.clearedAt) continue; // operator-cleared: never resurrect
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/plugin.test.js`
Expected: PASS — including the existing `a fresh distress alarm is re-raised after a restart` test (uncleared events still re-raise).

- [ ] **Step 5: Commit**

```bash
cd ~/src/sailingnaturali/signalk-dsc
git add index.js test/plugin.test.js
git commit -m "feat: reannounce skips operator-cleared events"
```

---

## Task 3: PUT clear handler registration + behavior

**Files:**
- Modify: `index.js` (mock-able via `app.registerPutHandler`; called in `plugin.start`)
- Modify: `test/plugin.test.js` (extend `mockApp` with `registerPutHandler`)
- Test: `test/plugin.test.js`

- [ ] **Step 1: Extend the mock app with `registerPutHandler`**

In `test/plugin.test.js`, inside `mockApp()`, add before `return app;`:

```javascript
  app.putHandlers = {};
  app.registerPutHandler = (context, path, cb) => {
    app.putHandlers[`${context}:${path}`] = cb;
  };
```

- [ ] **Step 2: Write the failing tests**

Add to `test/plugin.test.js`:

```javascript
test('start registers PUT clear handlers for the three notifying categories', () => {
  const app = mockApp();
  const plugin = start(app);
  for (const cat of ['distress', 'urgency', 'safety']) {
    assert.ok(
      app.putHandlers[`vessels.self:notifications.dsc.${cat}`],
      `missing PUT handler for ${cat}`
    );
  }
  plugin.stop();
});

test('a PUT clears the live alarm and stamps clearedAt on stored events', async () => {
  const app = mockApp();
  const plugin = start(app);

  // Raise a distress alarm.
  app.parsers.DSC(sentenceInput(DISTRESS));
  assert.equal(app.deltas.length, 1);

  // Operator clears it.
  const handler = app.putHandlers['vessels.self:notifications.dsc.distress'];
  const result = handler('vessels.self', 'notifications.dsc.distress', null, () => {});
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.statusCode, 200);

  // Live alarm cleared from the plugin's own source (null value).
  const clearDelta = app.deltas[app.deltas.length - 1].delta.updates[0].values[0];
  assert.equal(clearDelta.path, 'notifications.dsc.distress');
  assert.equal(clearDelta.value, null);

  // Stored event stamped so a restart won't resurrect it.
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.ok(events[0].clearedAt);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/plugin.test.js`
Expected: FAIL — no PUT handlers registered (`app.putHandlers` empty).

- [ ] **Step 4: Write the implementation**

In `index.js`, add a `clearCategory` helper near `notify` (after the `notify` function, before `shouldLogbook`):

```javascript
  /** Clear an active DSC alarm: drop the live notification from our own source
   *  and stamp the stored events so the restart reannounce skips them. */
  function clearCategory(category) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: `notifications.dsc.${category}`, value: null }] }],
    });
    store.markCleared((e) => e.category === category, new Date().toISOString());
  }
```

Then in `plugin.start`, after the `app.on('N2KAnalyzerOut', onPgn);` line and before `started = true;`, register the handlers:

```javascript
    // Let an operator clear an active DSC alarm: a PUT to the notification path
    // drops the live alert and marks the stored call(s) so a restart will not
    // re-raise it. The readwrite device token authorizes this write.
    for (const category of Object.keys(NOTIFICATION_STATES)) {
      app.registerPutHandler('vessels.self', `notifications.dsc.${category}`, () => {
        clearCategory(category);
        return { state: 'COMPLETED', statusCode: 200 };
      });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test test/plugin.test.js`
Expected: PASS (all plugin tests green).

- [ ] **Step 6: Run the full suite**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test`
Expected: PASS — every test file green.

- [ ] **Step 7: Commit**

```bash
cd ~/src/sailingnaturali/signalk-dsc
git add index.js test/plugin.test.js
git commit -m "feat: PUT handler clears DSC alarms durably (live + reannounce)"
```

---

## Task 4: `clear-dsc-alarm.js` script + npm wiring

**Files:**
- Create: `scripts/clear-dsc-alarm.js`
- Modify: `package.json` (add `clear-dsc` script)

- [ ] **Step 1: Write the script**

Create `scripts/clear-dsc-alarm.js`:

```javascript
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
  for (const category of targets) {
    const { status, body } = await clear(category, args);
    const ok = status >= 200 && status < 300;
    console.log(`${ok ? 'cleared' : 'FAILED'} ${category} → HTTP ${status} ${body}`);
    if (!ok && args.category !== 'all') process.exit(1);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 2: Verify it parses and runs (no server needed for the arg-guard path)**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node scripts/clear-dsc-alarm.js --category bogus`
Expected: prints `Unknown category "bogus"...` and exits non-zero.

Run: `cd ~/src/sailingnaturali/signalk-dsc && SIGNALK_TOKEN= node scripts/clear-dsc-alarm.js`
Expected: prints the `No token.` message and exits non-zero.

- [ ] **Step 3: Add the npm script**

In `package.json`, in `"scripts"`, add after the `send-test-dsc` line:

```json
    "clear-dsc": "node scripts/clear-dsc-alarm.js",
```

- [ ] **Step 4: Commit**

```bash
cd ~/src/sailingnaturali/signalk-dsc
git add scripts/clear-dsc-alarm.js package.json
git commit -m "feat: clear-dsc-alarm.js script + npm run clear-dsc"
```

---

## Task 5: Live verification against the Pi

**Files:** none (manual verification)

- [ ] **Step 1: Deploy the updated plugin to the Pi**

The Pi runs the published package, so verify against a freshly-published build OR temporarily sync. Simplest pre-release check — install the local build into the running container:

Run:
```bash
rsync -a --delete ~/src/sailingnaturali/signalk-dsc/ naturalaspi:/tmp/signalk-dsc-build/
ssh naturalaspi 'docker cp /tmp/signalk-dsc-build/index.js signalk:/home/node/.signalk/node_modules/@sailingnaturali/signalk-dsc/index.js && docker cp /tmp/signalk-dsc-build/lib/store.js signalk:/home/node/.signalk/node_modules/@sailingnaturali/signalk-dsc/lib/store.js && cd ~/signalk && docker compose restart signalk'
```
Expected: container restarts cleanly.

- [ ] **Step 2: Inject a test distress, confirm it raises**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node scripts/send-test-dsc.js`
Then: `curl -s -o /dev/null -w "%{http_code}\n" http://naturalaspi.local:3000/signalk/v1/api/vessels/self/notifications/dsc/distress`
Expected: HTTP 200 (alarm raised).

- [ ] **Step 3: Clear it with the new script**

Run: `SIGNALK_TOKEN=$(grep -E '^SIGNALK_TOKEN=' ~/.hermes/.env | cut -d= -f2-) node scripts/clear-dsc-alarm.js`
Expected: `cleared distress → HTTP 200 ...`

- [ ] **Step 4: Confirm it's gone and stays gone past the reannounce window**

Run:
```bash
curl -s -o /dev/null -w "live: %{http_code}\n" http://naturalaspi.local:3000/signalk/v1/api/vessels/self/notifications/dsc/distress
ssh naturalaspi 'cd ~/signalk && docker compose restart signalk'
# wait ~40s for startup + the 30s reannounce, then:
curl -s -o /dev/null -w "after restart: %{http_code}\n" http://naturalaspi.local:3000/signalk/v1/api/vessels/self/notifications/dsc/distress
```
Expected: `live: 404` (or resolved normal) immediately, and `after restart: 404` — the cleared call does not resurrect.

---

## Task 6: Docs + release

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json` (version)

- [ ] **Step 1: Document in README.md**

Add a "Clearing an alarm" subsection near where DSC notifications are described. Content:

```markdown
### Clearing an alarm

A received distress/urgency/safety call raises `notifications.dsc.<category>` and is
re-raised for up to an hour across server restarts. To clear an active alarm — dropping
the live notification and stopping the restart re-raise:

    SIGNALK_TOKEN=<readwrite-token> npm run clear-dsc -- --category distress

`--category all` clears all three. Clearing is a write, so it needs a readwrite token
(the same one used to fire a test MOB). A new incoming call still alarms normally.
```

- [ ] **Step 2: Add a CHANGELOG.md entry**

Add a new version section at the top (matching the existing format):

```markdown
## 0.3.0

- Clear active DSC alarms: a PUT to `notifications.dsc.<category>` drops the live
  notification and marks the stored call so a server restart no longer re-raises it.
- New `clear-dsc` script / `npm run clear-dsc` (`--category distress|urgency|safety|all`).
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

- [ ] **Step 4: Run the full suite one more time**

Run: `cd ~/src/sailingnaturali/signalk-dsc && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/src/sailingnaturali/signalk-dsc
git add README.md CHANGELOG.md package.json
git commit -m "chore: v0.3.0 — clear DSC alarms (clear-dsc script + PUT handler)"
```

- [ ] **Step 6: Release (per workspace policy)**

Before tagging, run the signalk-registry score check (workspace policy requires it before every release). Then:

```bash
cd ~/src/sailingnaturali/signalk-dsc
git push
gh release create v0.3.0 --title v0.3.0 --notes "Clear active DSC alarms (clear-dsc script + PUT handler)."
```
Expected: the OIDC publish workflow publishes `@sailingnaturali/signalk-dsc@0.3.0` to npm.

- [ ] **Step 7: Install the published build on the Pi (replace the temp-synced files)**

```bash
ssh naturalaspi 'docker exec signalk sh -c "cd ~/.signalk && npm install @sailingnaturali/signalk-dsc@0.3.0" && cd ~/signalk && docker compose restart signalk'
```
Expected: clean install of the published version, container restarts.
