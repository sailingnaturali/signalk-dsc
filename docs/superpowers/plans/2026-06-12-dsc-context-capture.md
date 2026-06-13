# DSC Context Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture own-ship context (position, motion, wind, sea state, visibility, cloud coverage) on every stored DSC event, put structured `vhf`/`observations` fields on the radio-log entry, and stop discarding the proposed working channel.

**Architecture:** A new `lib/snapshot.js` reads a default-plus-configurable list of SignalK self paths at call-receive time and attaches an `ownShip` block to the stored event; `postLogbook` derives logbook `observations` from that block and always sends `vhf: "70"`. `lib/dsc.js` gains working-channel parsing for non-distress calls. The signalk-logbook fork gets a small `plugin/entryFields.js` extraction so the POST handler can accept `vhf` and merge (not clobber) `observations` — destined for an upstream PR.

**Tech Stack:** Node (CommonJS), `node --test` + `node:assert/strict` in both repos. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-dsc-context-capture-design.md`

**Repos:** Tasks 1–6 run in `~/src/sailingnaturali/signalk-dsc`. Tasks 7–8 run in `~/src/sailingnaturali/signalk-logbook` (Bryan's fork of meri-imperiumi/signalk-logbook). There is no deploy-order dependency: the logbook silently ignores unknown POST body fields, so the plugin change is safe to ship before the fork change.

**Conventions that bind every task:**
- TDD: failing test first, minimal implementation, green, commit.
- All sentence-field values arrive over RF and are hostile-input class — sanitize before any use (see the nature-of-distress precedent in `lib/dsc.js:114-123`).
- The spoken notification message must NOT change. No task touches `buildMessage`.
- Commit messages: conventional-commit style (`feat:`, `fix:`, `docs:`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Part A — signalk-dsc

### Task 1: Working-channel parsing in the DSC sentence parser

For non-distress calls whose first telecommand is not `21` (ship position), field 5 may carry the proposed working channel. ITU-R M.493 encodes a VHF channel in the frequency field as a leading `9` followed by the zero-padded channel (`900072` = ch 72); some radios emit the bare channel digits. Positions are 10-digit strings and must never parse as a channel.

**Files:**
- Modify: `lib/dsc.js`
- Test: `test/dsc.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/dsc.test.js`:

```js
test('routine individual call with bare working channel digits', () => {
  // tc1=00 (all modes TP): field 5 is a channel, not a position.
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,0072,1902,,,B,E*7B'));
  assert.equal(ev.category, 'routine');
  assert.equal(ev.workingChannel, '72');
  assert.equal(ev.position, undefined);
});

test('M.493 9-prefixed channel encoding is normalized', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,900072,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, '72');
});

test('four-digit simplex channels survive intact', () => {
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,00,26,1078,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, '1078');
});

test('position telecommand (21) never yields a working channel', () => {
  // Existing routine-position sentence: tc1=21 → field 5 is a position.
  const ev = parseDsc(parts('$CDDSC,20,3381581370,00,21,26,1423108312,1902,,,B,E*7B'));
  assert.equal(ev.workingChannel, undefined);
  assert.ok(ev.position);
});

test('distress alerts never yield a working channel', () => {
  const ev = parseDsc(parts('$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A'));
  assert.equal(ev.workingChannel, undefined);
});

test('hostile or implausible channel fields are dropped', () => {
  for (const bad of ['__proto__', '12.3', 'constructor', '4242424242', '218450', '0', '100', '3001', '']) {
    const ev = parseDsc(parts(`$CDDSC,20,3381581370,00,00,26,${bad},1902,,,B,E*00`));
    assert.equal(ev.workingChannel, undefined, `expected ${JSON.stringify(bad)} to be dropped`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/dsc.test.js`
Expected: the six new tests FAIL (`workingChannel` is `undefined` where a value is expected; hostile cases may pass vacuously — that is fine, the positive cases prove the gap).

- [ ] **Step 3: Implement `parseChannel` and wire it into `parseDsc`**

In `lib/dsc.js`, after `parseUtcTime`:

```js
// VHF channel plausibility: 1–99 (international) or the 4-digit simplex
// forms (10NN / 20NN). The field arrives over the air unvalidated — anything
// that does not normalize to one of these shapes is dropped.
function parseChannel(raw) {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  const t = raw.trim();
  // ITU-R M.493 frequency field: a leading 9 on a 6-digit value marks
  // "channel number follows", zero-padded (900072 = channel 72).
  const digits = /^9\d{5}$/.test(t) ? t.slice(1) : t;
  const n = Number(digits);
  if (!Number.isInteger(n)) return undefined;
  if ((n >= 1 && n <= 99) || (n >= 1001 && n <= 1099) || (n >= 2001 && n <= 2099)) {
    return String(n);
  }
  return undefined;
}
```

In `parseDsc`, extend the position branch with an else:

```js
  if (distress || field(parts, 3) === TELECOMMAND_SHIP_POSITION) {
    event.position = parsePosition(field(parts, 5));
    event.utcTime = parseUtcTime(field(parts, 6));
  } else {
    const channel = parseChannel(field(parts, 5));
    if (channel) event.workingChannel = channel;
  }
```

Export it: `module.exports = { parseDsc, parsePosition, parseMmsi, parseUtcTime, parseChannel, NATURES };`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/dsc.test.js`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/dsc.js test/dsc.test.js
git commit -m "feat: parse proposed working channel from non-distress DSC calls

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Own-ship snapshot module

New module: read a list of `{ field, path }` pairs via `app.getSelfPath`, build a (possibly nested) `ownShip` object, and derive logbook `observations` from it. Raw values are stored as SignalK provides them (rad, m/s, Pa, meters); conversion happens only at the logbook boundary.

**Files:**
- Create: `lib/snapshot.js`
- Create: `test/snapshot.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureOwnShip, buildObservations, visibilityToFogScale } = require('../lib/snapshot');

function appWithState(state) {
  return { getSelfPath: (p) => state[p] };
}

test('captures the default fields that have values, nesting wind', () => {
  const app = appWithState({
    'navigation.position': { value: { latitude: 48.76, longitude: -123.05 } },
    'navigation.speedOverGround': 3.1,
    'environment.wind.speedOverGround': { value: 8.2 },
    'environment.wind.directionTrue': 5.5,
    'environment.water.swell.state': 3,
  });
  const snap = captureOwnShip(app);
  assert.deepEqual(snap.position, { latitude: 48.76, longitude: -123.05 });
  assert.equal(snap.sog, 3.1);
  assert.deepEqual(snap.wind, { speed: 8.2, direction: 5.5 });
  assert.equal(snap.seaState, 3);
  assert.equal(snap.cog, undefined); // absent path → absent field, never fabricated
});

test('returns undefined when nothing is available', () => {
  assert.equal(captureOwnShip(appWithState({})), undefined);
});

test('a throwing getSelfPath skips the field, never throws out', () => {
  const app = {
    getSelfPath: (p) => {
      if (p === 'navigation.position') throw new Error('boom');
      if (p === 'navigation.speedOverGround') return 2.0;
      return undefined;
    },
  };
  assert.deepEqual(captureOwnShip(app), { sog: 2.0 });
});

test('extra configured paths are captured; unsafe field names are rejected', () => {
  const app = appWithState({ 'environment.depth.belowTransducer': 12.2 });
  const snap = captureOwnShip(app, [
    { field: 'depth', path: 'environment.depth.belowTransducer' },
    { field: '__proto__.polluted', path: 'environment.depth.belowTransducer' },
    { field: 'constructor', path: 'environment.depth.belowTransducer' },
  ]);
  assert.deepEqual(snap, { depth: 12.2 });
  assert.equal({}.polluted, undefined);
});

test('visibility meters → fog scale table', () => {
  // Fog scale is logarithmic: 0 <50 m … 9 ≥50 km.
  assert.equal(visibilityToFogScale(49), 0);
  assert.equal(visibilityToFogScale(50), 1);
  assert.equal(visibilityToFogScale(1500), 4);
  assert.equal(visibilityToFogScale(25000), 8);
  assert.equal(visibilityToFogScale(80000), 9);
  // A small integer is already a fog-scale code: pass through.
  assert.equal(visibilityToFogScale(7), 7);
  assert.equal(visibilityToFogScale(-1), undefined);
  assert.equal(visibilityToFogScale('fog'), undefined);
});

test('buildObservations takes only valid codes and converts visibility', () => {
  assert.deepEqual(
    buildObservations({ seaState: 3, cloudCoverage: 6, visibility: 1500, sog: 3.1 }),
    { seaState: 3, cloudCoverage: 6, visibility: 4 }
  );
  // Out-of-range codes are dropped, not clamped.
  assert.deepEqual(buildObservations({ seaState: 12, cloudCoverage: 9 }), undefined);
  assert.equal(buildObservations(undefined), undefined);
  assert.equal(buildObservations({ sog: 3.1 }), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/snapshot.test.js`
Expected: FAIL with `Cannot find module '../lib/snapshot'`.

- [ ] **Step 3: Implement `lib/snapshot.js`**

```js
'use strict';

/*
 * Own-ship context snapshot, taken at DSC call receive time.
 *
 * The stored event is the forensic record of the moment a call arrived; the
 * snapshot answers "what was our situation when we heard it". Values are
 * stored exactly as SignalK provides them (rad, m/s, Pa, meters) — absent
 * sensor, absent field, never fabricated. Conversion to logbook units
 * happens only in buildObservations.
 */

const DEFAULT_SNAPSHOT_FIELDS = [
  { field: 'position', path: 'navigation.position' },
  { field: 'cog', path: 'navigation.courseOverGroundTrue' },
  { field: 'sog', path: 'navigation.speedOverGround' },
  { field: 'heading', path: 'navigation.headingTrue' },
  { field: 'wind.speed', path: 'environment.wind.speedOverGround' },
  { field: 'wind.direction', path: 'environment.wind.directionTrue' },
  { field: 'pressure', path: 'environment.outside.pressure' },
  // signalk-logbook conventions (no SignalK spec paths exist for these).
  { field: 'seaState', path: 'environment.water.swell.state' },
  { field: 'visibility', path: 'environment.outside.visibility' },
  { field: 'cloudCoverage', path: 'environment.outside.cloudCoverage' },
];

const UNSAFE_KEY = /^(__proto__|constructor|prototype)$/;

function unwrap(node) {
  return node && typeof node === 'object' && 'value' in node ? node.value : node;
}

/** Read the default + configured paths off the data model. Best-effort:
 *  a throwing read skips that field. Returns undefined when empty. */
function captureOwnShip(app, extraFields = []) {
  const snapshot = {};
  const fields = DEFAULT_SNAPSHOT_FIELDS.concat(Array.isArray(extraFields) ? extraFields : []);
  for (const entry of fields) {
    if (!entry || typeof entry.field !== 'string' || typeof entry.path !== 'string') continue;
    const keys = entry.field.split('.');
    if (keys.some((k) => !k || UNSAFE_KEY.test(k))) continue;
    let value;
    try {
      value = unwrap(app.getSelfPath(entry.path));
    } catch {
      continue;
    }
    if (value === undefined || value === null) continue;
    let target = snapshot;
    for (const key of keys.slice(0, -1)) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
      target = target[key];
    }
    target[keys[keys.length - 1]] = value;
  }
  return Object.keys(snapshot).length ? snapshot : undefined;
}

// Upper bounds (meters, exclusive) for fog-scale codes 0–8; ≥50 km is 9.
const FOG_SCALE_METERS = [50, 200, 500, 1000, 2000, 4000, 10000, 20000, 50000];

/** Meters → logbook fog-scale 0–9. A small integer (≤9) is assumed to
 *  already be a fog-scale code and passes through. */
function visibilityToFogScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (Number.isInteger(value) && value <= 9) return value;
  const idx = FOG_SCALE_METERS.findIndex((limit) => value < limit);
  return idx === -1 ? 9 : idx;
}

/** signalk-logbook observations block from a snapshot. Only keys with valid
 *  values; undefined when there are none. */
function buildObservations(ownShip) {
  if (!ownShip) return undefined;
  const obs = {};
  if (Number.isInteger(ownShip.seaState) && ownShip.seaState >= 0 && ownShip.seaState <= 9) {
    obs.seaState = ownShip.seaState;
  }
  if (
    Number.isInteger(ownShip.cloudCoverage) &&
    ownShip.cloudCoverage >= 0 &&
    ownShip.cloudCoverage <= 8
  ) {
    obs.cloudCoverage = ownShip.cloudCoverage;
  }
  const visibility = visibilityToFogScale(ownShip.visibility);
  if (visibility !== undefined) obs.visibility = visibility;
  return Object.keys(obs).length ? obs : undefined;
}

module.exports = { captureOwnShip, buildObservations, visibilityToFogScale, DEFAULT_SNAPSHOT_FIELDS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/snapshot.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot.js test/snapshot.test.js
git commit -m "feat: own-ship snapshot module with logbook observations mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Attach the snapshot to stored events (+ `snapshotPaths` config)

Snapshot on first receipt only — dedupe repeats must not refresh it (the original context is the forensic record).

**Files:**
- Modify: `index.js`
- Test: `test/plugin.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/plugin.test.js` (the `mockApp`/`sentenceInput`/`start` helpers and `DISTRESS` constant already exist there):

```js
function selfStateApp(state) {
  const app = mockApp();
  app.getSelfPath = (p) => (p === 'mmsi' ? '368000001' : state[p]);
  return app;
}

test('stored events carry an ownShip snapshot of current vessel state', async () => {
  const app = selfStateApp({
    'navigation.position': { value: { latitude: 48.76, longitude: -123.05 } },
    'navigation.speedOverGround': 3.1,
    'environment.water.swell.state': 3,
  });
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));

  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.deepEqual(events[0].ownShip.position, { latitude: 48.76, longitude: -123.05 });
  assert.equal(events[0].ownShip.sog, 3.1);
  assert.equal(events[0].ownShip.seaState, 3);
  assert.equal(events[0].ownShip.visibility, undefined); // nothing fabricated
  plugin.stop();
});

test('no vessel state → no ownShip block at all', async () => {
  const app = mockApp();
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal('ownShip' in events[0], false);
  plugin.stop();
});

test('dedupe repeats do not refresh the snapshot', async () => {
  const state = { 'navigation.speedOverGround': 3.1 };
  const app = selfStateApp(state);
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  state['navigation.speedOverGround'] = 9.9;
  app.parsers.DSC(sentenceInput(DISTRESS)); // re-transmission, deduped
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events.length, 1);
  assert.equal(events[0].ownShip.sog, 3.1);
  plugin.stop();
});

test('snapshotPaths config adds fields to the snapshot', async () => {
  const app = selfStateApp({ 'environment.depth.belowTransducer': 12.2 });
  const plugin = start(app, {
    snapshotPaths: [{ field: 'depth', path: 'environment.depth.belowTransducer' }],
  });
  app.parsers.DSC(sentenceInput(DISTRESS));
  const events = Object.values(await app.resourceProviders['dsc-calls'].methods.listResources());
  assert.equal(events[0].ownShip.depth, 12.2);
  plugin.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: the four new tests FAIL (no `ownShip` on events).

- [ ] **Step 3: Wire the snapshot into `record()` and the schema**

In `index.js`:

Add to the requires block:

```js
const { captureOwnShip, buildObservations } = require('./lib/snapshot');
```

In `plugin.schema.properties`, after `logbookToken`:

```js
      snapshotPaths: {
        type: 'array',
        title: 'Extra own-ship paths to snapshot on each call',
        description:
          'Each entry adds a field to the stored event\'s ownShip block (position, course, speed, wind, pressure, sea state, visibility and cloud coverage are always attempted).',
        default: [],
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', title: 'Field name in ownShip' },
            path: { type: 'string', title: 'SignalK self path' },
          },
        },
      },
```

In `record()`, after the duplicate check returns and before `store.add(event)`:

```js
    // Own-ship context at receive time — the forensic record of the moment
    // the call arrived. First receipt only: repeats keep the original.
    const ownShip = captureOwnShip(app, options.snapshotPaths);
    if (ownShip) event.ownShip = ownShip;

    store.add(event);
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS — all files, including the untouched voice-message tests.

- [ ] **Step 5: Commit**

```bash
git add index.js test/plugin.test.js
git commit -m "feat: snapshot own-ship context onto stored DSC events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Logbook entry gains `vhf: "70"` and `observations`

DSC is received on channel 70 by definition, so every radio-log entry gets `vhf: "70"`. Observations come from the snapshot via `buildObservations` and are included only when non-empty. (The fork-side POST support is Tasks 7–8; an unpatched logbook ignores the extra fields, so this is safe to ship first.)

**Files:**
- Modify: `index.js:154-167` (`postLogbook`)
- Test: `test/plugin.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/plugin.test.js` (the `logbookServer` helper already exists):

```js
test('logbook entry carries vhf 70 and observations from the snapshot', async () => {
  const { server, received, port } = await logbookServer();
  const app = selfStateApp({
    'environment.water.swell.state': 3,
    'environment.outside.visibility': 1500, // meters → fog scale 4
  });
  const plugin = start(app, {
    logbookUrl: `http://127.0.0.1:${port}/plugins/signalk-logbook/logs`,
    logbookToken: 'test-token',
  });
  app.parsers.DSC(sentenceInput(DISTRESS));

  const req = await received;
  assert.equal(req.body.category, 'radio');
  assert.equal(req.body.vhf, '70');
  assert.deepEqual(req.body.observations, { seaState: 3, visibility: 4 });
  server.close();
  plugin.stop();
});

test('no observations key on the logbook entry when nothing is observed', async () => {
  const { server, received, port } = await logbookServer();
  const app = mockApp();
  const plugin = start(app, {
    logbookUrl: `http://127.0.0.1:${port}/plugins/signalk-logbook/logs`,
    logbookToken: 'test-token',
  });
  app.parsers.DSC(sentenceInput(DISTRESS));

  const req = await received;
  assert.equal(req.body.vhf, '70');
  assert.equal('observations' in req.body, false);
  server.close();
  plugin.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: the two new tests FAIL (`vhf` undefined).

- [ ] **Step 3: Extend the POST body in `postLogbook`**

In `index.js`, replace the `body:` line of `postLogbook` with:

```js
      body: JSON.stringify({
        text: buildLogbookText(event, messageContext(event)),
        ago: 0,
        category: 'radio',
        // DSC is received on VHF channel 70 by definition.
        vhf: '70',
        ...(() => {
          const observations = buildObservations(event.ownShip);
          return observations ? { observations } : {};
        })(),
      }),
```

(If the IIFE reads awkwardly against the file's style, compute `const observations = buildObservations(event.ownShip);` above the `fetch` call and spread `...(observations ? { observations } : {})` — either is fine; match what lints clean.)

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js test/plugin.test.js
git commit -m "feat: send vhf 70 and snapshot observations on logbook entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Working channel in the logbook text

The `vhf` field is the receive channel; the *proposed* working channel goes into the entry text (and is already on the stored event from Task 1).

**Files:**
- Modify: `lib/format.js:73-92` (`buildLogbookText`)
- Test: `test/format.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/format.test.js` (match the file's existing import of `buildLogbookText`):

```js
test('logbook text mentions the proposed working channel', () => {
  const text = buildLogbookText({
    category: 'routine',
    mmsi: '338158137',
    workingChannel: '72',
    source: 'nmea0183',
  });
  assert.match(text, /proposed working channel 72/);
});

test('no working-channel clause when the call had none', () => {
  const text = buildLogbookText({ category: 'routine', mmsi: '338158137' });
  assert.doesNotMatch(text, /working channel/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/format.test.js`
Expected: first new test FAILS.

- [ ] **Step 3: Implement**

In `lib/format.js` `buildLogbookText`, after the position/utcTime block and before `if (event.source)`:

```js
  if (event.workingChannel) parts.push(`proposed working channel ${event.workingChannel}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/format.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/format.js test/format.test.js
git commit -m "feat: log the proposed working channel in the radio-log text

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, changelog, full verification

**Files:**
- Modify: `README.md` (Configuration table + What you get section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the new behavior**

In `README.md`, add to the Configuration table (after the `logbookToken` row):

```markdown
| `snapshotPaths` | `[]` | Extra `{ field, path }` pairs added to the `ownShip` snapshot on each stored call (position, course, speed, wind, pressure, sea state, visibility and cloud coverage are always attempted). |
```

In the "What you get" section, add two bullets (match the list style in place):

```markdown
- Every stored call carries an `ownShip` snapshot of the moment it arrived —
  position, course, speed, wind, pressure, and (when a source publishes them)
  sea state, visibility, and cloud coverage. Absent sensor, absent field.
- Logbook entries are written with `vhf: "70"` (DSC is received on channel 70
  by definition) plus structured `observations`; non-distress calls that
  propose a working channel get it in the entry text and on the stored event
  as `workingChannel`.
```

In `CHANGELOG.md`, add above the `## [0.1.1]` section:

```markdown
## [Unreleased]

### Added

- `ownShip` snapshot on every stored call: position, COG/SOG, heading, wind,
  pressure, and the logbook observation conventions (sea state, visibility,
  cloud coverage) when a source publishes them. Extra paths via the new
  `snapshotPaths` config option.
- Logbook entries now carry `vhf: "70"` and an `observations` block derived
  from the snapshot (visibility converted meters → fog scale).
- The proposed working channel of non-distress calls (sentence field 5,
  including the ITU-R M.493 `9`-prefixed encoding) is parsed — sanitised as
  over-the-air input — onto the event as `workingChannel` and into the
  logbook text.
```

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: PASS, every test file.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document ownShip snapshot, vhf/observations, working channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Part B — signalk-logbook fork

Work in `~/src/sailingnaturali/signalk-logbook`. The currently checked-out branch is `fix/twin-engine-hours` (an open PR branch) — do not touch it. `main` tracks upstream cleanly.

Upstream context for the PR: `stateToEntry` (plugin/format.js) auto-captures observations from vessel state, but the POST handler **replaces** that block when the request body carries `observations` (plugin/index.js:254-257), silently dropping the auto-captured `seaState`. And `vhf` exists on the `Entry` schema but cannot be supplied at creation time. Both are small, upstreamable fixes.

### Task 7: Extract and test body-field application

**Files:**
- Create: `plugin/entryFields.js`
- Create: `test/entryFields.test.js`
- Branch: `feat/post-vhf-observations` off `main`

- [ ] **Step 1: Create the branch**

```bash
cd ~/src/sailingnaturali/signalk-logbook
git checkout main && git pull origin main
git checkout -b feat/post-vhf-observations
```

- [ ] **Step 2: Write the failing tests**

Create `test/entryFields.test.js` (style matches the existing `test/format.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert');
const applyBodyFields = require('../plugin/entryFields');

test('category defaults to navigation and is overridable from the body', () => {
  assert.strictEqual(applyBodyFields({}, {}).category, 'navigation');
  assert.strictEqual(applyBodyFields({}, { category: 'radio' }).category, 'radio');
});

test('body observations merge with auto-captured ones instead of replacing', () => {
  const data = { observations: { seaState: 3 } };
  const entry = applyBodyFields(data, { observations: { visibility: 4 } });
  assert.deepStrictEqual(entry.observations, { seaState: 3, visibility: 4 });
});

test('body observations win over auto-captured values on conflict', () => {
  const data = { observations: { seaState: 3 } };
  const entry = applyBodyFields(data, { observations: { seaState: 5 } });
  assert.strictEqual(entry.observations.seaState, 5);
});

test('vhf is accepted from the body when it fits the schema constraint', () => {
  assert.strictEqual(applyBodyFields({}, { vhf: '70' }).vhf, '70');
  assert.strictEqual(applyBodyFields({}, { vhf: '9' }).vhf, '9');
});

test('invalid vhf values are ignored rather than failing entry validation', () => {
  assert.strictEqual(applyBodyFields({}, { vhf: '700' }).vhf, undefined);
  assert.strictEqual(applyBodyFields({}, { vhf: '' }).vhf, undefined);
  assert.strictEqual(applyBodyFields({}, { vhf: 70 }).vhf, undefined);
});

test('manual position from the body is copied', () => {
  const entry = applyBodyFields({}, { position: { latitude: 48.7, longitude: -123.0 } });
  assert.deepStrictEqual(entry.position, { latitude: 48.7, longitude: -123.0 });
});

test('state-derived fields pass through untouched', () => {
  const entry = applyBodyFields({ heading: 190, vhf: '16' }, {});
  assert.strictEqual(entry.heading, 190);
  assert.strictEqual(entry.vhf, '16'); // auto-captured channel kept when body has none
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/entryFields.test.js`
Expected: FAIL with `Cannot find module '../plugin/entryFields'`.

- [ ] **Step 4: Implement `plugin/entryFields.js`**

```js
/**
 * Apply the request-body fields of POST /logs onto an entry produced by
 * stateToEntry. Body values win over auto-captured ones, but observations
 * merge key-by-key so a manual visibility doesn't drop an auto-captured
 * sea state. Invalid vhf values are ignored here so they can't fail Entry
 * schema validation at append time.
 */
module.exports = function applyBodyFields(data, body) {
  const entry = {
    ...data,
  };
  if (body.category) {
    entry.category = body.category;
  } else {
    entry.category = 'navigation';
  }
  if (body.observations) {
    entry.observations = {
      ...data.observations,
      ...body.observations,
    };
  }
  if (typeof body.vhf === 'string' && body.vhf.length >= 1 && body.vhf.length <= 2) {
    entry.vhf = body.vhf;
  }
  if (body.position) {
    entry.position = {
      ...body.position,
    };
  }
  return entry;
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/entryFields.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add plugin/entryFields.js test/entryFields.test.js
git commit -m "Extract POST body field application, accept vhf, merge observations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire into the POST handler + schema, verify, push

**Files:**
- Modify: `plugin/index.js:248-273` (POST `/logs` handler)
- Modify: `schema/openapi.yaml:156-170` (`NewEntry`)
- Regenerate: `schema/openapi.json` (via the build)

- [ ] **Step 1: Replace the inline body handling in `plugin/index.js`**

Add the require near the top with the other local requires:

```js
const applyBodyFields = require('./entryFields');
```

In the `router.post('/logs', ...)` handler, replace this block:

```js
      const data = stateToEntry(stats, req.body.text, author);
      if (req.body.category) {
        data.category = req.body.category;
      } else {
        data.category = 'navigation';
      }
      if (req.body.observations) {
        data.observations = {
          ...req.body.observations,
        };
        if (!Number.isNaN(Number(data.observations.seaState))) {
          sendDelta(
            app,
            plugin,
            new Date(data.datetime),
            'environment.water.swell.state',
            data.observations.seaState,
          );
        }
      }
      if (req.body.position) {
        data.position = {
          ...req.body.position,
        };
        // TODO: Send delta on manually entered position?
      }
```

with:

```js
      const data = applyBodyFields(stateToEntry(stats, req.body.text, author), req.body);
      if (req.body.observations && !Number.isNaN(Number(req.body.observations.seaState))) {
        sendDelta(
          app,
          plugin,
          new Date(data.datetime),
          'environment.water.swell.state',
          data.observations.seaState,
        );
      }
      // TODO: Send delta on manually entered position?
```

(The sendDelta condition stays keyed on the *body* supplying seaState — merged-in auto values must not echo a delta back into SignalK, exactly as before.)

- [ ] **Step 2: Add `vhf` to `NewEntry` in `schema/openapi.yaml`**

After the `observations` property of `NewEntry` (around line 169):

```yaml
        vhf:
          type: string
          maxLength: 2
          minLength: 1
          example: '70'
```

Do not hand-edit `schema/openapi.json` — the build regenerates it.

- [ ] **Step 3: Full verification (lint + build + tests)**

Run: `npm test`
Expected: PASS — eslint clean, webpack build regenerates `schema/openapi.json`, all `node --test` files green. Confirm `git diff schema/openapi.json` shows the `vhf` addition to `NewEntry`.

- [ ] **Step 4: Commit and push the branch**

```bash
git add plugin/index.js schema/openapi.yaml schema/openapi.json
git commit -m "Accept vhf on POST /logs and document it in NewEntry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin feat/post-vhf-observations
```

- [ ] **Step 5: Draft the upstream PR text — do NOT open the PR**

Write a draft PR body (informal tone, technical content only) covering: the observations-clobber fix, `vhf` at creation time, and the motivating use case (a DSC plugin writing radio-log entries: receive channel is always 70). Present the draft to Bryan in the session for review — he reviews all outbound text before anything is opened against upstream.

---

## Final integration check

- [ ] In `signalk-dsc`: `npm test` — full suite green.
- [ ] In `signalk-logbook` on `feat/post-vhf-observations`: `npm test` — full suite green.
- [ ] `node scripts/send-test-dsc.js` against the Pi (`naturalaspi.local:7777`) once deployed, then confirm the stored call at `http://naturalaspi.local:3000/signalk/v2/api/resources/dsc-calls` shows an `ownShip` block (the mock vessel publishes position/wind, so those fields must appear; seaState/visibility/cloudCoverage must be absent — nothing fabricated).
