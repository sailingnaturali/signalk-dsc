# DSC chart-marker layer (`dsc-call-markers`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `dsc-call-markers` resource type that serves logged DSC calls as freeboard ResourceSets (one per category) so chartplotters draw them with detail in the popup.

**Architecture:** A pure builder (`lib/markers.js`) turns stored call events into per-category freeboard ResourceSets (GeoJSON Point FeatureCollections). `index.js` registers a second, read-only resource provider that calls the builder against the existing `store` on each request. The canonical `dsc-calls` log and event schema are untouched.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, `@signalk/server-api` resource provider API.

**Spec:** `docs/superpowers/specs/2026-06-21-dsc-chart-markers-design.md`

---

## File structure

- Create: `lib/markers.js` — pure `buildMarkerResourceSets(events, opts)`; no `app` dependency.
- Create: `test/markers.test.js` — unit tests for the builder.
- Modify: `index.js` — require the builder, add `markerWindowHours` to schema + defaults, register the `dsc-call-markers` provider.
- Modify: `test/plugin.test.js` — provider registration + read-only + integration test.
- Modify: `README.md` — document the new layer + freeboard setup.
- Modify: `CHANGELOG.md` — `[0.5.0]` Added entry.
- Modify: `package.json` — version bump (at release time).

---

## Task 1: Builder — grouping, Point features, properties

**Files:**
- Create: `lib/markers.js`
- Test: `test/markers.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/markers.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMarkerResourceSets } = require('../lib/markers');

const NOW = Date.parse('2026-06-21T20:00:00Z');

function evt(over = {}) {
  return {
    category: 'distress',
    natureOfDistress: 'fire',
    mmsi: '316200911',
    position: { latitude: 48.9, longitude: -123.23 },
    utcTime: '03:37',
    receivedAt: '2026-06-21T19:50:00Z',
    ...over,
  };
}

test('groups calls into per-category ResourceSets with FeatureCollection values', () => {
  const sets = buildMarkerResourceSets(
    [evt(), evt({ category: 'routine', natureOfDistress: undefined, mmsi: '338158137' })],
    { now: NOW, windowHours: 24, nameFor: () => undefined }
  );
  assert.deepEqual(Object.keys(sets).sort(), ['distress', 'routine']);
  assert.equal(sets.distress.values.type, 'FeatureCollection');
  assert.equal(sets.distress.values.features.length, 1);
});

test('each feature is a GeoJSON Point with [lon, lat] order', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24 });
  const f = sets.distress.values.features[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [-123.23, 48.9]);
});

test('feature properties carry nature, category, mmsi, times, and vesselName', () => {
  const sets = buildMarkerResourceSets([evt()], {
    now: NOW,
    windowHours: 24,
    nameFor: (mmsi) => (mmsi === '316200911' ? 'Wind Chaser' : undefined),
  });
  const p = sets.distress.values.features[0].properties;
  assert.equal(p.name, 'distress: fire');
  assert.equal(p.category, 'distress');
  assert.equal(p.natureOfDistress, 'fire');
  assert.equal(p.mmsi, '316200911');
  assert.equal(p.utcTime, '03:37');
  assert.equal(p.receivedAt, '2026-06-21T19:50:00Z');
  assert.equal(p.vesselName, 'Wind Chaser');
});

test('vesselName property is omitted when not resolvable', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24, nameFor: () => undefined });
  assert.equal('vesselName' in sets.distress.values.features[0].properties, false);
});

test('calls without a position are skipped', () => {
  const sets = buildMarkerResourceSets([evt({ position: undefined })], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('per-category default style carries the category colour', () => {
  const sets = buildMarkerResourceSets([evt()], { now: NOW, windowHours: 24 });
  assert.equal(sets.distress.styles.default.stroke, 'rgba(211,47,47,1)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/markers.test.js`
Expected: FAIL — `Cannot find module '../lib/markers'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/markers.js`. Note `now`/`windowHours` are accepted but unused in this task — the window filter arrives in Task 2.

```js
'use strict';

// Per-category marker colour, emitted as the ResourceSet `styles.default`.
// Freeboard styles a feature from styles[properties.styleRef] and falls back to
// styles.default, so one default per category colours all of that set's markers.
const CATEGORY_COLORS = {
  distress: 'rgba(211,47,47,1)', // red
  urgency: 'rgba(245,124,0,1)', // orange
  safety: 'rgba(251,192,45,1)', // amber
  routine: 'rgba(117,117,117,1)', // grey
};

function toFeature(event, nameFor) {
  const vesselName = nameFor ? nameFor(event.mmsi) : undefined;
  const properties = {
    name: event.natureOfDistress
      ? `${event.category}: ${event.natureOfDistress}`
      : event.category,
    category: event.category,
    mmsi: event.mmsi,
    utcTime: event.utcTime,
    receivedAt: event.receivedAt,
  };
  if (event.natureOfDistress) properties.natureOfDistress = event.natureOfDistress;
  if (vesselName) properties.vesselName = vesselName;
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [event.position.longitude, event.position.latitude],
    },
    properties,
  };
}

// Turn stored DSC call events into freeboard ResourceSets keyed by category.
// Empty categories are omitted.
function buildMarkerResourceSets(events, { now, windowHours, nameFor } = {}) {
  const buckets = {};
  for (const event of events) {
    if (!event.position || typeof event.position.latitude !== 'number') continue;
    const category = event.category || 'routine';
    (buckets[category] = buckets[category] || []).push(toFeature(event, nameFor));
  }
  const out = {};
  for (const [category, features] of Object.entries(buckets)) {
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.routine;
    out[category] = {
      name: `DSC — ${category}`,
      description: `DSC ${category} calls heard on channel 70`,
      styles: { default: { width: 2, stroke: color, fill: color } },
      values: { type: 'FeatureCollection', features },
    };
  }
  return out;
}

module.exports = { buildMarkerResourceSets, CATEGORY_COLORS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/markers.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/markers.js test/markers.test.js
git commit -m "feat(markers): build per-category DSC marker ResourceSets"
```

---

## Task 2: Builder — recency window + distress-stays-until-cleared

**Files:**
- Modify: `lib/markers.js`
- Test: `test/markers.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/markers.test.js`:

```js
test('non-distress older than the window is excluded', () => {
  const old = evt({ category: 'routine', natureOfDistress: undefined, receivedAt: '2026-06-20T10:00:00Z' });
  const sets = buildMarkerResourceSets([old], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});

test('non-distress within the window is included', () => {
  const recent = evt({ category: 'routine', natureOfDistress: undefined, receivedAt: '2026-06-21T10:00:00Z' });
  const sets = buildMarkerResourceSets([recent], { now: NOW, windowHours: 24 });
  assert.equal(sets.routine.values.features.length, 1);
});

test('un-cleared distress older than the window is still shown', () => {
  const oldDistress = evt({ receivedAt: '2026-06-19T10:00:00Z' });
  const sets = buildMarkerResourceSets([oldDistress], { now: NOW, windowHours: 24 });
  assert.equal(sets.distress.values.features.length, 1);
});

test('cleared distress is excluded once outside the window', () => {
  const clearedOld = evt({ receivedAt: '2026-06-19T10:00:00Z', clearedAt: '2026-06-19T10:05:00Z' });
  const sets = buildMarkerResourceSets([clearedOld], { now: NOW, windowHours: 24 });
  assert.deepEqual(Object.keys(sets), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/markers.test.js`
Expected: FAIL — `non-distress older than the window is excluded` (and the cleared-distress test) fail because no filtering exists yet; the two "included/shown" tests pass.

- [ ] **Step 3: Write minimal implementation**

In `lib/markers.js`, add the helper above `toFeature`:

```js
const HOUR_MS = 60 * 60 * 1000;

// Should this call appear at `now`? Un-cleared distress is always shown — a
// MAYDAY must not age off the chart. Everything else (and cleared distress)
// must fall within `windowHours` of receipt.
function withinWindow(event, now, windowHours) {
  if (event.category === 'distress' && !event.clearedAt) return true;
  const received = Date.parse(event.receivedAt);
  if (Number.isNaN(received)) return false;
  return now - received <= windowHours * HOUR_MS;
}
```

Then add the filter as the second line of the loop in `buildMarkerResourceSets`:

```js
  for (const event of events) {
    if (!event.position || typeof event.position.latitude !== 'number') continue;
    if (!withinWindow(event, now, windowHours)) continue;
    const category = event.category || 'routine';
    (buckets[category] = buckets[category] || []).push(toFeature(event, nameFor));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/markers.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/markers.js test/markers.test.js
git commit -m "feat(markers): recency window, keep active distress until cleared"
```

---

## Task 3: Wire the `dsc-call-markers` provider + config

**Files:**
- Modify: `index.js`
- Test: `test/plugin.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/plugin.test.js` (the `DISTRESS` constant, `mockApp`, `start`, `sentenceInput` helpers already exist there):

```js
test('start registers the dsc-call-markers resource provider', () => {
  const app = mockApp();
  const plugin = start(app);
  assert.ok(app.resourceProviders['dsc-call-markers']);
  plugin.stop();
});

test('dsc-call-markers is read-only', () => {
  const app = mockApp();
  const plugin = start(app);
  const methods = app.resourceProviders['dsc-call-markers'].methods;
  assert.throws(() => methods.setResource('x', {}));
  assert.throws(() => methods.deleteResource('x'));
  plugin.stop();
});

test('a distress call shows up in the dsc-call-markers distress set', async () => {
  const app = mockApp();
  const plugin = start(app);
  app.parsers.DSC(sentenceInput(DISTRESS));
  const sets = await app.resourceProviders['dsc-call-markers'].methods.listResources();
  assert.ok(sets.distress);
  assert.equal(sets.distress.values.features.length, 1);
  assert.equal(sets.distress.values.features[0].geometry.type, 'Point');
  plugin.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: FAIL — `app.resourceProviders['dsc-call-markers']` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `index.js`, add the require alongside the others near the top:

```js
const { buildMarkerResourceSets } = require('./lib/markers');
```

Add the config option to `plugin.schema.properties` (place after `maxEvents`):

```js
      markerWindowHours: {
        type: 'number',
        title: 'Chart marker window (hours)',
        description:
          'Non-distress calls drop off the dsc-call-markers chart layer after this many hours. Active (un-cleared) distress calls always remain.',
        default: 24,
      },
```

Add the default to the `options = { ... }` block in `plugin.start`:

```js
      markerWindowHours: 24,
```

Register the second provider immediately after the existing `dsc-calls`
`app.registerResourceProvider({ ... })` block. `vesselName` is the existing
top-level AIS-name lookup closure:

```js
    app.registerResourceProvider({
      type: 'dsc-call-markers',
      methods: {
        async listResources() {
          return buildMarkerResourceSets(store.list(), {
            now: Date.now(),
            windowHours: options.markerWindowHours,
            nameFor: vesselName,
          });
        },
        async getResource(id) {
          const sets = buildMarkerResourceSets(store.list(), {
            now: Date.now(),
            windowHours: options.markerWindowHours,
            nameFor: vesselName,
          });
          if (!sets[id]) throw new Error(`No DSC calls in category: ${id}`);
          return sets[id];
        },
        setResource() {
          throw new Error('dsc-call-markers is read-only');
        },
        deleteResource() {
          throw new Error('dsc-call-markers is read-only');
        },
      },
    });
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS — all prior tests plus the 3 new ones. Output pristine.

- [ ] **Step 5: Commit**

```bash
git add index.js test/plugin.test.js
git commit -m "feat: serve DSC calls as the dsc-call-markers chart layer"
```

---

## Task 4: Docs — README + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the README**

In the "What you get" list, add a bullet after the existing `dsc-calls` resource
bullet:

```markdown
- **A chart-marker layer** — `GET /signalk/v2/api/resources/dsc-call-markers`
  serves logged calls as [Freeboard-SK](https://github.com/SignalK/freeboard-sk)
  ResourceSets, one per category (distress/urgency/safety/routine), each a
  GeoJSON `FeatureCollection` of Point markers whose popup carries the nature,
  caller name/MMSI, and times. To use it in Freeboard: Settings → Resources
  (Custom) → add resource type `dsc-call-markers`, reload, then toggle the
  per-category layers. Non-distress calls drop off after `markerWindowHours`
  (default 24); an active (un-cleared) distress call stays until acknowledged.
  This is the *detail* layer — distinct from the prominent live SaR marker a
  distress call also draws via the `sar.` context (see Remote-vessel deltas).
```

Add `markerWindowHours` to the configuration options table (after `maxEvents`):

```markdown
| `markerWindowHours` | `24` | Non-distress calls leave the `dsc-call-markers` chart layer after this many hours; active distress stays until cleared. |
```

- [ ] **Step 2: Update the CHANGELOG**

Add at the top of the version list:

```markdown
## [0.5.0]

### Added

- New read-only `dsc-call-markers` resource (`/signalk/v2/api/resources/dsc-call-markers`):
  logged calls served as Freeboard-SK ResourceSets, one per category, as GeoJSON
  Point markers with nature / caller / time in the popup. Recency governed by the
  new `markerWindowHours` option (default 24); active distress stays until cleared.
```

- [ ] **Step 3: Verify the full suite still passes**

Run: `npm test`
Expected: PASS, output pristine.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document the dsc-call-markers chart layer (v0.5.0)"
```

---

## Release (after Bryan's go)

Not a task in this plan — release is a separate, explicitly-authorized step:
bump `package.json`/`package-lock.json` to 0.5.0 (`npm version 0.5.0 --no-git-tag-version`),
commit `chore(release): v0.5.0`, push, then `gh release create v0.5.0` (OIDC auto-publish).
Then deploy to the Pi and verify the per-category layers render in Freeboard.

---

## Self-review

- **Spec coverage:** new type (T3) · ResourceSet-per-category (T1) · GeoJSON Point/position-skip (T1) · popup properties incl. vesselName via `nameFor` (T1) · recency window + distress-stays-until-cleared 3a (T2) · read-only (T3) · `markerWindowHours` config (T3) · README/CHANGELOG/version (T4). All covered.
- **Placeholders:** none — every code/test step is complete.
- **Type consistency:** `buildMarkerResourceSets(events, { now, windowHours, nameFor })` and `CATEGORY_COLORS` used identically across tasks; provider methods match the `dsc-calls` provider's shape.
