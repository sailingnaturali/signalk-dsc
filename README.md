# signalk-dsc

SignalK plugin that receives, logs, and alerts on **DSC** (VHF digital selective
calling) traffic — distress, urgency, safety, and routine calls — from both
**NMEA 0183** (`$--DSC`/`$--DSE`) and **NMEA 2000** (PGN 129808).

## Why

When a vessel hits the red button, its radio broadcasts a DSC burst on channel 70
with MMSI, position, and nature of distress — perfectly readable even when the
follow-up voice call on 16 is not. Stock SignalK mostly drops this data: the 0183
hook misses common sentence variants and persists nothing, and the N2K converter
has **no** PGN 129808 mapping at all. If you might be the nearest boat, you want
every received alert stored with its position and surfaced as an alarm — that is
this plugin.

## What you get

For every DSC call heard by a connected radio:

- **A persistent call log** — JSONL on disk, served at
  `GET /signalk/v2/api/resources/dsc-calls` (anonymously readable when the server
  allows read-only access). Raw sentence/PGN is always kept alongside the parsed
  fields: time, MMSI, category, nature of distress, position, UTC time.
- **Alarms under your own vessel** — `notifications.dsc.distress` (state
  `emergency`), `notifications.dsc.urgency` (`alarm`), `notifications.dsc.safety`
  (`alert`). Routine calls never alarm. Repeated re-transmissions of the same
  alert (DSC auto-repeats until acknowledged) update the stored call instead of
  re-alarming. Alerts received within the last hour are **re-raised after a
  server restart** — notifications are in-memory, and a received MAYDAY must
  not vanish because the server bounced.
- **A voice-sized message** — the notification message is deliberately minimal
  (type, vessel, situation, range and direction from own position, action):
  > DSC distress alert: vessel Wind Chaser, sinking, 2.3 nautical miles
  > northwest. Monitor channel 16.

  Full detail (MMSI, coordinates, reported time, transport) goes to the call
  log and the logbook entry instead, so TTS pipelines stay terse.
- **Remote-vessel deltas** — the caller's `navigation.position` (and a distress
  notification) under `vessels.urn:mrn:imo:mmsi:<caller>`, so chartplotters can
  show where the call came from.
- **Optional ship's-log entries** via
  [signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook) — a
  GMDSS-style radio log of received distress/urgency/safety traffic.

## Transports

- **NMEA 0183**: registers custom `DSC` and `DSE` sentence parsers (these replace
  the server's stock DSC hook with a superset: tolerant of sparse distress alerts
  some radios emit — see [nmea0183-signalk#217](https://github.com/SignalK/nmea0183-signalk/issues/217)
  — and with `DSE` position refinement from ±1 NM to ten-thousandths of a minute,
  which the stock parser ignores entirely).
- **NMEA 2000**: listens to the server's analyzer stream (`N2KAnalyzerOut`) for
  PGN 129808, since `n2k-signalk` produces no delta for it.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `maxEvents` | `1000` | Oldest calls dropped beyond this. |
| `logbookEnabled` | `true` | Requires signalk-logbook and a token. |
| `logbookRoutine` | `false` | Also log routine calls. |
| `logbookUrl` | `http://localhost:3000/plugins/signalk-logbook/logs` | |
| `logbookToken` | _empty_ | SignalK access token; logbook writes are skipped without one (plugin routes are auth-gated). |

## Trying it without a radio

Feed sentences through any NMEA 0183 connection (TCP, UDP, file playback):

```
$CDDSC,12,3380400790,12,05,00,1423108312,2019,,,S,E*69
$CDDSE,1,1,A,3380400790,00,45894494*1B
```

…then `GET /signalk/v2/api/resources/dsc-calls`.

## Limitations

- Distress relays, acknowledgements, and cancellations are stored (with
  `acknowledgement`/`distressedMmsi` fields) but don't yet clear or transform the
  original alarm.
- Multi-sentence `DSE` groups are ignored (single-sentence covers Class-D gear).
- A raised distress notification stays active until cleared from the server —
  deliberate: a received MAYDAY should not silently expire.

## License

MIT
