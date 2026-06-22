# DSC chart-marker layer (`dsc-call-markers`)

**Status:** approved design, pending implementation
**Target release:** v0.5.0
**Date:** 2026-06-21

## Problem

A DSC distress caller now renders on chartplotters as a red Search-and-Rescue
target (v0.4.0, the `sar.` context). But that marker is **position-only**: its
popup reads "SaR Beacon" with lat/lon and nothing else — no nature of distress,
no caller identity, no time. And non-distress calls (urgency/safety/routine)
that carry a position are not surfaced on the chart at all.

The plugin already stores rich detail per call (`dsc-calls` log). We want that
detail visible on the chart, without disturbing the canonical log schema that
the MCP and logbook consume.

## Goals

- Plot DSC calls on the chart with their detail reachable in the feature popup.
- Cover **all** categories (distress included — it shows both as the live SaR
  marker and as a toggleable detail marker here).
- Group by category so each can be shown/hidden independently in freeboard.
- Keep recent calls only, configurably; never silently drop an active distress.

## Non-goals

- No change to the `dsc-calls` log resource or the stored event schema.
- No realtime push — freeboard re-fetches resources on bounds change and on a
  timer; regenerating from the store on each request is sufficient.
- Popup excludes range/bearing and working channel (per design decision).

## Design

### New resource type: `dsc-call-markers` (read-only)

A second `app.registerResourceProvider`, type `dsc-call-markers`, served at
`/signalk/v2/api/resources/dsc-call-markers` (anonymously readable under
`allow_readonly`, like `dsc-calls`). `setResource`/`deleteResource` throw.

`listResources()` returns an object keyed by category — `distress`, `urgency`,
`safety`, `routine` — each value a **freeboard ResourceSet**:

```js
{
  name: "DSC — distress",
  description: "DSC distress calls heard on channel 70",
  styles: { /* per-category default colour */ },
  values: { type: "FeatureCollection", features: [ /* one Point per call */ ] }
}
```

Categories with no qualifying calls are omitted. `getResource(category)` returns
the single ResourceSet or throws (404). Freeboard lists each ResourceSet as its
own toggle, satisfying the per-category requirement.

Default marker colours (overridable in freeboard): distress red, urgency orange,
safety amber, routine grey. Exact `styles` keys mirror what freeboard/
signalk-restricted-areas expect for point ResourceSets; confirmed against
freeboard during implementation.

### Feature shape

One GeoJSON Point per call **that has a position** (position-less calls stay in
the log, can't be plotted):

```js
{
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },   // GeoJSON lon-first
  properties: {
    name: "distress: fire and explosion",  // popup title
    category, natureOfDistress, mmsi,
    vesselName,        // resolved from AIS static data if heard; omitted if not
    utcTime,           // reported time from the call
    receivedAt         // when we logged it
  }
}
```

`properties` carries the popup detail chosen in design: nature + category,
vessel name + MMSI, times. (No range/bearing, no working channel.)

### Which calls render — the window

New config option `markerWindowHours` (number, default **24**). For each stored
call:

- **distress + not cleared** → always included, regardless of age (a MAYDAY must
  not drop off the chart while still active — design point 3a).
- **any other case** → included only if `receivedAt` is within the last
  `markerWindowHours` (cleared/old distress and aged-out other calls fall off).

`clearedAt` is stamped on a call by the existing alarm-clear path
(`markCleared`), so "cleared" is already represented on the event.

### Module boundary

`lib/markers.js` — one pure function, unit-testable in isolation:

```js
buildMarkerResourceSets(events, { now, windowHours, nameFor })
  // → { [category]: resourceSet }  for non-empty categories
```

`nameFor(mmsi) -> string | undefined` is injected (in production it wraps the
existing `vesselName(mmsi)` AIS lookup), keeping the builder pure and the tests
free of `app`. `index.js` wires the provider: on `listResources`, call the
builder with `store.list()`, `Date.now()`, `options.markerWindowHours`, and a
`nameFor` closure.

## Testing (TDD)

`test/markers.test.js` (pure):

1. Groups calls into per-category ResourceSets.
2. Each feature is a GeoJSON Point with `[lon, lat]` order.
3. `properties` include name, category, natureOfDistress, mmsi, vesselName,
   utcTime, receivedAt.
4. Calls without a position are skipped.
5. Non-distress older than the window is excluded; within the window included.
6. Un-cleared distress older than the window is still included (3a).
7. Cleared distress is excluded.
8. Empty categories are omitted.
9. `nameFor` populates `vesselName`; absent name → property omitted.

`test/plugin.test.js` additions:

10. `start` registers the `dsc-call-markers` provider.
11. `setResource`/`deleteResource` throw (read-only).

## Coupled surfaces (same change)

- README "What you get": new bullet describing `dsc-call-markers` + the
  one-time freeboard setup (add the resource path under Settings, enable the
  layer). Note the SaR marker (v0.4.0) vs this detail layer distinction.
- CHANGELOG `[0.5.0]` Added entry.
- `package.json` version → 0.5.0 at release time; release via `gh release create
  v0.5.0` (OIDC auto-publish).

## Open questions

None — design fully specified.
