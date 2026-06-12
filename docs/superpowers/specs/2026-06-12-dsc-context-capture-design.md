# DSC context capture — design

2026-06-12

## Problem

A DSC call is a moment you reconstruct later — from the alarm chain, the call
log, or the ship's log. Today the plugin records what the *caller* sent and
almost nothing about the world it arrived into:

- The logbook entry is written under the `radio` category but carries no VHF
  channel, even though DSC is by definition received on channel 70.
- Routine/individual calls propose a working channel in sentence field 5; we
  discard it.
- The stored event has no own-ship context — position, motion, wind, sea
  state, visibility — that would help someone (or an agent) later understand
  the situation around the call.

## Goals

- Capture own-ship context on every stored DSC event, independent of the
  logbook being installed or reachable.
- Put the structured fields the logbook already models (`vhf`,
  `observations`) onto the radio-log entry.
- Stop discarding the proposed working channel.
- Never fabricate data: absent sensor → absent field.
- Keep the spoken notification exactly as minimal as it is now.

## Design

### 1. Own-ship snapshot on the event record

On first receipt of a call (dedupe repeats do not refresh it), `record()`
attaches an `ownShip` block read synchronously via `app.getSelfPath()`:

| Field | SignalK path | Notes |
|---|---|---|
| `position` | `navigation.position` | |
| `cog` | `navigation.courseOverGroundTrue` | rad, as SignalK provides |
| `sog` | `navigation.speedOverGround` | m/s |
| `heading` | `navigation.headingTrue` | rad |
| `wind.speed` | `environment.wind.speedOverGround` | m/s |
| `wind.direction` | `environment.wind.directionTrue` | rad |
| `pressure` | `environment.outside.pressure` | Pa |
| `seaState` | `environment.water.swell.state` | WMO 0–9 (signalk-logbook convention) |
| `visibility` | `environment.outside.visibility` | meters if a source publishes it |
| `cloudCoverage` | `environment.outside.cloudCoverage` | oktas |

Only paths that return a value are included; an empty snapshot is omitted
entirely. A config option `snapshotPaths` (array of `{ field, path }`) lets
additional paths be captured without a release (future weather station,
vision-AI, etc.). The snapshot lands in `dsc-calls.jsonl` and is served by the
`dsc-calls` resource.

### 2. Structured logbook fields

The signalk-logbook POST gains:

- `vhf: "70"` on every DSC entry — the receive channel, fixed by the DSC
  system itself.
- `observations: { seaState?, cloudCoverage?, visibility? }` built from the
  snapshot; keys present only when we have values. Visibility in meters is
  converted to the logbook's 0–9 fog scale with a fixed threshold table
  (fog scale is logarithmic: 0 < 50 m … 9 > 50 km).

### 3. Proposed working channel

For non-distress calls whose first telecommand indicates a channel follows
(not telecommand 21 = position), parse field 5 as the proposed working
channel. The value arrives over RF and is hostile-input class (same as the
nature-of-distress fix): accept only digit strings that normalize to a
plausible VHF channel — 1–2 digit channels (`06`, `72`) and 4-digit simplex
forms (`1078`); everything else is dropped. Stored as `workingChannel` on the
event and appended to the logbook text ("proposed working channel 72"). It is
*not* put in the `vhf` field: that is the receive channel, and the schema caps
it at 2 characters.

### 4. signalk-logbook fork changes (separate repo, then upstream)

In `clarkbw/signalk-logbook`:

- Accept `vhf` in the POST body, validated to the existing `Entry.vhf`
  constraint (string, 1–2 chars); add it to `NewEntry` in the OpenAPI schema.
- Fix the existing clobber bug: a body-supplied `observations` currently
  replaces the auto-captured one (dropping auto `seaState`); merge instead,
  body keys winning.

Both changes go upstream as a PR once proven locally.

### 5. Non-goals

- The spoken notification message is unchanged — context never enters the
  voice path.
- No carry-forward of stale manual observations; live paths only.
- No new SignalK deltas are emitted for own-ship state (we only read).

## Error handling

- Snapshot reads are best-effort: a throwing `getSelfPath` skips that field,
  never blocks recording or alarming.
- Logbook POST failures stay non-fatal and logged, as today.
- Working-channel sanitization failures drop the field silently; the raw
  sentence is already preserved on the event.

## Testing

TDD. New/extended tests:

- `dsc.test.js`: working-channel parsing — valid 1/2/4-digit forms, position
  telecommand exclusion, hostile inputs (`__proto__`, dotted, oversized,
  non-numeric).
- `plugin.test.js`: snapshot capture (full, partial, empty SignalK state),
  dedupe repeats don't refresh the snapshot, logbook payload shape (`vhf`,
  conditional `observations`), `snapshotPaths` config.
- `format.test.js`: visibility meters → fog-scale table; logbook text gains
  the working channel.
- Fork test suite: POST with `vhf` (valid/invalid), observations merge keeps
  auto `seaState`.
