# AGENTS.md — signalk-dsc

SignalK Node Server plugin. Receives, logs, and alerts on DSC (VHF digital selective calling) calls — distress, urgency, safety, routine — from NMEA 0183 ($CDDSC/$CDDSE) and NMEA 2000 (PGN 129808). Built on `@sailingnaturali/signalk-distress-core`.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (`node --test`) |
| `npm run send-test-dsc` | Fire a synthetic DSC call at UDP `naturalaspi:7777` (or `--host/--port`) |
| `npm run clear-dsc -- --category distress` | Bulk-clear active DSC alarms via HTTP PUT; needs `SIGNALK_TOKEN` (readwrite) |

## Test without a radio

```bash
# Add UDP input in SignalK: pipedProviders → simple NMEA0183 UDP port 7777
npm run send-test-dsc              # default: sinking, MMSI 366191919
npm run send-test-dsc -- --nature mob
npm run send-test-dsc -- --nature fire --category urgency
# Verify:
curl http://localhost:3000/signalk/v2/api/resources/dsc-calls
```

Clearing is a write — always needs a readwrite token:
```bash
SIGNALK_TOKEN=<jwt> npm run clear-dsc -- --category all
```

## Architecture (what you'd miss from filenames)

- **Entry**: `index.js` exports `makePlugin(app)` — SignalK calls this.
- **EventStore** (from distress-core) persists to `dsc-calls.jsonl` in SignalK's data dir.
- **Two transports**:
  - NMEA 0183: registers custom `DSC`/`DSE` sentence parsers via `app.emitPropertyValue('nmea0183sentenceParser', ...)`. These replace the server's stock DSC hook with a superset (tolerant of sparse alerts, plus DSE position refinement).
  - NMEA 2000: listens on `app.on('N2KAnalyzerOut')` for PGN 129808 (n2k-signalk produces no delta for it).
- **Notifier**: single `notifier` → alarms at `notifications.received.<category>.dsc-<id>` (`distress`→`emergency`, `urgency`→`alarm`, `safety`→`warn`). Routine calls never alarm.
- **Dedupe**: 5-minute window by MMSI+category+nature. Repeats slide the window, never re-alarm.
- **Reannounce on restart**: 30s delay, 1-hour window. Re-raises the newest alert per category.
- **Caller context**: distress → `sar.urn:mrn:imo:mmsi:<caller>` (SaR target); everything else → `vessels.urn:mrn:imo:mmsi:<caller>`.
- **Resource providers**: `dsc-calls` (history) and `dsc-call-markers` (chart layer, bucketed by category).
- **DSCWatch reporting**: on by default, queues undelivered reports on disk (`dscwatch-queue.jsonl`), retries on reconnect. CI-safe: non-loopback URLs suppressed under `CI=true`.
- **Optional logbook**: writes via `signalk-logbook` if `logbookToken` configured (see below).

## Key files

```
index.js                 # plugin factory, start/stop, notifiers, resource providers
lib/dsc.js               # parse $CDDSC sentences
lib/dse.js               # parse $CDDSE position refinement sentences
lib/pgn129808.js         # normalize canboatjs PGN 129808 fields → canonical event
lib/dscwatch.js          # build DSCWatch reports
scripts/send-test-dsc.js # builds a valid DSC sentence, sends UDP
scripts/clear-dsc-alarm.js # PUTs notification path to clear alarm + stamp stored event
```

## Test notes

- Uses Node's built-in `node:test` (no Jest/Vitest).
- `test/helpers.js` has `mockApp()` and `start()` — the app contract lives there.
- `reannounceDelayMs: 0` fires the restart reannounce immediately (test seam, schema-hidden).
- Run single test file: `node --test test/plugin.test.js`

## Logbook integration (signalk-logbook v2 Resources API)

Prefers the SignalK v2 Resources API (`app.resourcesApi.setResource`) over the legacy
plugin REST API — no separate URL or cookie handling when the SignalK app provides
`resourcesApi`.

- **Default**: v2 Resources API (`/signalk/v2/api/resources/logentries`) — needs only a
  `logbookToken` (readwrite). Payload uses `uuid`, `origin: 'auto'`, `category: 'radio'`,
  and `vhf: '70'` (DSC is received on channel 70 by definition).
- **Fallback**: if `resourcesApi` is unavailable and `logbookUrl` is set, falls back to
  the v1 REST API with Bearer + `JAUTHENTICATION` cookie (backward compat).
- **Disabled by default in tests**: `logbookToken` empty in `mockApp()` → `shouldLogbook()`
  returns false → no writes attempted.
- **Errors**: logged via `app.error()` with the HTTP status or writer-missing reason.

## Gotchas

- **Never press your radio's distress button to test** — launches a real SAR alert. README has a `WARNING` box.
- `start()` degrades gracefully if `app.streambundle` missing (plugin-ci harness).
- `npm run clear-dsc` hits HTTP `:3000` (REST API), not the UDP injection port.
- DSC is receive-only: no radio exposes a transmit interface to be commanded (see README "Future work").
- Visibility on `environment.outside.visibility` is read as meters and converted to the logbook 0–9 fog scale; an integer ≤ 9 is assumed to already be a fog-scale code, so sub-10-meter metric readings would be misread.
- Chart markers only for calls with a position; text-only PGN 129808 calls never appear there.
