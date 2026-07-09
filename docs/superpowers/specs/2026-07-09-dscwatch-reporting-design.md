# DSCWatch reporting — design

**Date:** 2026-07-09
**Repos:** `@sailingnaturali/signalk-distress-core` (new reporter module), `@sailingnaturali/signalk-dsc` (payload mapping + wiring)

## Goal

Submit every received DSC message to the DSCWatch.com crowdsourced receiver
network (`POST https://dscwatch.com/api/v1/report/<receiver-key>`), as an
opt-in feature. Reporting must never interfere with the plugin's primary job:
local alarms, the call store, and the logbook.

## Architecture

Two units with a clean boundary:

- **`signalk-distress-core` → `lib/reporter.js`** — a generic, service-agnostic
  "deliver JSON payloads to an HTTP endpoint through a persistent queue" module.
  It knows nothing about DSC field semantics; payloads are opaque. This is the
  piece `signalk-ais-distress` can reuse if DSCWatch (or another service) later
  accepts AIS survival-beacon reports.
- **`signalk-dsc` → `lib/dscwatch.js`** — a pure payload builder: normalized
  DSC event → DSCWatch report body. All DSC semantics stay in the DSC plugin.

## Reporter module (distress-core)

```js
const reporter = createReporter({
  url,            // full endpoint including receiver key
  userAgent,      // e.g. 'signalk-dsc/0.6.0'
  queueFile,      // JSONL path in the plugin's data dir
  maxQueue = 5000,
  log,            // (msg) => void, plugin's app.debug/app.error split
  onPermanentError, // (status, body) => void — surfaced as plugin status
  fetchImpl = fetch, // injected for tests
});
reporter.report(payload); // append to queue, kick flusher; never throws
reporter.start();
reporter.stop();
```

### Delivery semantics (aligned with the DSCWatch spec)

- **Write-through, not batching.** `report()` appends the payload to the JSONL
  queue and immediately kicks the flusher: when the network is healthy the
  queue is a pass-through and the POST fires within milliseconds of the parse.
  The append-before-POST ordering is crash-safety (a report survives the
  process dying mid-flight), not delay.
- **No client-side dedupe.** Every radio repeat and every DSE refinement is
  its own queue entry and its own POST. The backend dedupes (receiver key +
  `mmsi` + `category` + `natureOfDistress`, 15-minute window).
- **Sequential, in-order flush** so DSE refinements follow their originals.

### Queue & retry policy

JSONL file, append-only; entries removed (file compacted) as they resolve.
`maxQueue` caps growth by dropping oldest entries.

Per the DSCWatch response table, resolution is per entry:

| Outcome | Action |
| --- | --- |
| `2xx` (200 merged / 201 created) | Dequeue. `created` is ignored. |
| `400` | Dequeue, log — a retry cannot fix a bad body. |
| `404` | Dequeue, log, call `onPermanentError` — receiver key is wrong or disabled; plugin status says "check receiver key" once, no spam. |
| Network error (offline) | Keep indefinitely (up to `maxQueue`), exponential backoff capped at 5 min. Everything behind it is failing for the same reason, so head-of-line ordering costs nothing. This is the multi-day-offline catch-up path. |
| `5xx` (server reachable but erroring) | Retry with backoff, **capped at ~10 attempts (~30 min) per entry, then drop** and move on — a payload the server persistently rejects must not block the queue behind it. This is the spec's "retry, then drop according to local policy" applied per entry. |

Flusher resumes on `start()`, on every `report()`, and on a backoff timer.

**Late-delivery note:** catch-up after an offline stretch delivers reports
hours after their `receivedAt`. `receivedAt` is always the true receive time —
never rewritten — so the server can handle staleness however it chooses.
Worst case a long-offline incident surfaces as one merged incident rather
than a live-looking timeline; no wrong behavior either way.

### Receiver key

Config field. When blank, generate a UUID (lowercase) once and persist it
beside the queue file (`dscwatch-receiver-key` in the data dir); reuse it on
every subsequent start. Users who want station attribution may enter their
9-digit MMSI instead. Zero-config default; no MMSI leakage unless chosen.

## signalk-dsc integration

### Payload builder (`lib/dscwatch.js`)

Pure function `buildReport(event, { ownPosition })` → DSCWatch body. The
normalized event shape maps nearly 1:1:

| DSCWatch field | Source |
| --- | --- |
| `receivedAt`, `source`, `category`, `format`, `mmsi`, `natureOfDistress`, `relay`, `distressedMmsi`, `deviceBeacon`, `workingChannel`, `acknowledgement`, `expansion`, `self`, `positionResolution`, `position`, `utcTime` | event fields, omitted when absent |
| `raw` | NMEA 0183 sentence string, or the PGN fields object for n2k |
| `ownPosition` | own-ship GPS fix at receive time (`selfPosition()`) |
| `positionRefined` | `true` only on the DSE refinement report |

All categories are reported once enabled, routine included — the backend
dedupes, and client-side filtering only undercuts coverage mapping.

### Hook points

Both fire *before/independent of* the local store dedupe, because the spec
requires every repeat to be sent even though `record()` collapses repeats
inside its 5-minute window:

1. **`record()`** — build + `report()` for every parse, on both the fresh-call
   path and the duplicate (repeat) path.
2. **`dseParser()`** — after `refinePosition`, a second report with the refined
   `position`, `positionResolution: 'enhanced'`, `positionRefined: true`.

Reporting is strictly fire-behind: `report()` never throws and never blocks
or delays the alarm, store, or logbook path.

### Config schema

One new section, all under existing plugin config:

| Option | Default | Notes |
| --- | --- | --- |
| `dscwatchEnabled` | `false` | **Opt-in.** When enabled, the full payload including `ownPosition` is sent — a receiver network needs receiver positions to be useful. |
| `dscwatchReceiverKey` | `''` | Blank = auto-generated persisted UUID; or enter the station's 9-digit MMSI. |
| `dscwatchUrl` | `https://dscwatch.com/api/v1/report` | Base URL, overridable for testing; receiver key is appended as the path segment. |

`User-Agent: signalk-dsc/<version>` from package.json.

## Error handling

- Reporter failures log via `app.error`; transient retry chatter via `app.debug`.
- A `404` (bad/disabled receiver key) sets plugin status once
  ("DSCWatch: receiver key rejected — check configuration") rather than spamming.
- Disabled feature = reporter never constructed; zero overhead.

## Testing (TDD, `node --test`)

- **distress-core reporter:** injected `fetchImpl`; queue persistence across
  restart; in-order delivery; 400/404 drop vs network-keep vs 5xx-cap-then-drop;
  backoff; `maxQueue` trim; write-through latency (flush kicked on `report()`).
- **signalk-dsc payload builder:** golden tests built from the DSCWatch spec's
  two examples (distress alert, DSE refinement).
- **signalk-dsc integration:** repeats and DSE refinements each produce a POST
  while the local store still dedupes; `self` flag set for own-MMSI calls;
  disabled feature produces no reporter activity.

## Release

Ships as two coordinated releases: distress-core minor (new `reporter` module,
0.5.0) first, then signalk-dsc minor (0.6.0) with the core dependency bumped.
