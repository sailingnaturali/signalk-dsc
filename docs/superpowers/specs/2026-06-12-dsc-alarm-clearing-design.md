# DSC alarm clearing — design

**Date:** 2026-06-12
**Status:** approved

## Problem

A received DSC distress (or urgency/safety) call raises `notifications.dsc.<category>`
under *self* so the vessel's alarm chain fires. There is currently **no way to clear
that alarm**, and clearing is not as simple as it looks:

- The notification lives only in SignalK's in-memory model. Sending a `null` delta from
  an *external* client (e.g. a WebSocket write) does not remove it — SignalK records it
  as a second source for the path, leaving the plugin's original `emergency` value in the
  multiplexed `values` map. The resolved value reads `normal`, but the stale source lingers.
- Worse, the plugin **re-raises** the newest still-fresh alert per category 30s after every
  startup (`reannounceTimer`, window = `REANNOUNCE_WINDOW_MS` = 1h), replaying it from the
  on-disk JSONL store. So a server restart resurrects a "cleared" alarm for up to an hour.

The only durable manual fix today is editing `dsc-calls.jsonl` on disk and restarting the
container. We want a first-class, network-reachable way to clear an alarm.

## Goal

A clear capability in the plugin, plus a thin script (`scripts/clear-dsc-alarm.js`,
mirroring `send-test-dsc.js`) that clears an active DSC alarm durably — both the live
notification and the re-raise-on-restart behavior.

Non-goals (YAGNI): per-call clearing, acknowledge/silence semantics, clearing the
remote-vessel-context notification (it is neither persisted nor reannounced, so it dies on
its own).

## Approach

Clearing is implemented **in the plugin** and exposed as a **SignalK PUT handler on the
notification path** — not a custom plugin route. Rationale:

- PUT handlers are SignalK-native and work with the **readwrite device token**
  (`SIGNALK_TOKEN`, the same one that fires a test MOB) — no admin JWT required.
- They don't disturb anonymous reads (`allow_readonly`).
- Registering one is also what lets the SignalK admin UI offer a clear button for the path.
- The script becomes a thin network client, no ssh/docker, exactly like `send-test-dsc.js`.

## Components

### 1. Plugin clear handler (`index.js`)

Register a PUT handler for each notifying category — `notifications.dsc.distress`,
`notifications.dsc.urgency`, `notifications.dsc.safety`. On any PUT (the only reason to
write these paths is to clear them), the handler:

1. **Clears the live alarm** — `app.handleMessage(plugin.id, …)` emitting `value: null` for
   that path *from the plugin's own source*. Clearing the owning source (rather than
   overlaying a second one) is the fix for the stale-source problem above.
2. **Defeats the re-raise** — stamps `clearedAt` on every stored event of that category so
   the startup reannounce skips them.
3. Returns `{ state: 'COMPLETED', statusCode: 200 }`.

The reannounce loop (around `index.js:364`) gains one guard: `if (event.clearedAt) continue;`.

A *new* incoming distress sentence still creates a fresh, uncleared event and alarms
normally — clearing only silences what has already been received. A re-transmission of an
already-cleared call within the 5-minute dedupe window bumps `repeats` without re-notifying
(existing dedupe path), so a cleared-but-still-repeating call stays silent.

Clearing is **per-category** — the natural unit, since the notification is per-category and
newest-wins.

### 2. `EventStore` (`lib/store.js`)

Add `markCleared(predicate, at)`: sets `clearedAt = at` on every matching event and compacts
the file **once** (avoids N rewrites). Keeps the clear logic readable in `index.js`.

### 3. `scripts/clear-dsc-alarm.js` + npm `clear-dsc`

Mirrors `send-test-dsc.js`:

- `--host` (default `naturalaspi.local`)
- `--port` (default `3000` — HTTP, not the UDP injection port; clearing is an authenticated
  control action)
- `--category` (default `distress`; accepts `all` to clear distress + urgency + safety)
- `--token` (defaults to `$SIGNALK_TOKEN`)

Issues `PUT /signalk/v1/api/vessels/self/notifications/dsc/<category>` with body
`{"value":null}` and `Authorization: Bearer <token>`. Prints the server result; friendly
error if the token is missing. The repo convention is no automated test for scripts (cf.
`send-test-dsc.js`); verified manually against the Pi.

## Testing (TDD)

New cases in `test/plugin.test.js` (the mock app gains a `registerPutHandler` that records
handlers by `context + path`):

- PUT handlers are registered for all three notifying categories.
- A PUT emits a null clearing delta for that category from the plugin source.
- A PUT stamps `clearedAt` on the matching stored event(s).
- A cleared event is **not** re-raised on restart — alongside the existing
  "a fresh distress alarm *is* re-raised after a restart" test staying green.

New case in `test/store.test.js`: `markCleared` sets `clearedAt` on matching events,
leaves others untouched, and persists across reload.

## Release

Patch/minor version bump, `CHANGELOG.md` + `README.md` entries documenting the clear
capability and the `clear-dsc` script. Run the signalk-registry score check before the
release (per workspace policy). `gh release create vX.Y.Z` auto-publishes via OIDC.
