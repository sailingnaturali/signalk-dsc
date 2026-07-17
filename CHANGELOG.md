# Changelog

All notable changes to `@sailingnaturali/signalk-dsc` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0]

### Changed

- Received-call alarms now use a per-call key `notifications.received.<category>.dsc-<id>`
  (was one fixed path per category), so two concurrent calls no longer overwrite one
  alarm. Acknowledge an individual alarm by PUTting its own path; the CLI's
  `--category` bulk-clear still clears every active call of a category. Requires the
  `receivedPath` export from `@sailingnaturali/signalk-distress-core`.

### Added

- A DSC distress with nature *man overboard* also raises the flat legacy
  `notifications.mob` self-key (alongside the per-vessel record) so existing MOB
  subscribers keep firing until they migrate to the `received.*` scheme.

## [0.6.1]

### Changed

- DSCWatch reporting now defaults to **on** (`dscwatchEnabled: true`) — opt-out
  instead of opt-in. A received DSC call carries nothing private, and the crowd
  safety map is worth more coverage. Set `dscwatchEnabled: false` to keep all data
  on the boat. Confirmed with DSCWatch that auto-generated UUID receiver keys are
  accepted with no registration.

## [0.6.0]

### Added

- Opt-in DSCWatch.com reporting (`dscwatchEnabled`, default `false`): every received
  call, repeat, and DSE position refinement is submitted to the DSCWatch crowdsourced
  receiver network through a persistent write-through queue with offline catch-up.
  Receiver identity is a persisted UUID (`dscwatch-receiver-key`) or a configured
  station MMSI. Local-only fields (`ownShip` snapshots, spoken messages, event IDs)
  are never sent.

### Changed

- `@sailingnaturali/signalk-distress-core` bumped to `^0.5.1` (adds `createReporter`
  and `loadOrCreateReceiverKey` used by the DSCWatch integration).

## [0.5.7]

### Documentation

- README now points to the companion
  [`@sailingnaturali/signalk-ais-distress`](https://github.com/sailingnaturali/signalk-ais-distress)
  plugin (DSC alerts; AIS finds the casualty), making the cross-reference
  reciprocal.

## [0.5.6]

### Fixed

- A distress alert that keeps auto-repeating past the 5-minute dedupe window no
  longer re-alarms every window or resurrects an operator's clear. Via
  `@sailingnaturali/signalk-distress-core` 0.3.0's `findRecent` fix, repeats now
  slide the dedupe window forward, so one MAYDAY stays one stored call, alarmed
  once, and a cleared alarm stays cleared while the radio keeps repeating it.

### Changed

- Notification raise/clear and restart-reannounce now use the shared
  `createNotifier` from `@sailingnaturali/signalk-distress-core` (bumped to
  `^0.3.0`), replacing the hand-rolled notification delta and the duplicated
  inline reannounce loop. Behavior is preserved (per-category state, the
  `timestamp` field, newest-per-category re-raise). Logbook writes already use
  the core `writeLogbookEntry`.

## [0.5.5]

### Changed

- Logbook writes now use `writeLogbookEntry` from `@sailingnaturali/signalk-distress-core`
  (bumped to `^0.2.0`) instead of an inline `fetch`. No behavior change.

## [0.5.4]

### Changed

- Internals now consume `@sailingnaturali/signalk-distress-core` for the event
  store, chart-marker builder, spoken/logbook rendering, snapshot helpers, and
  the shared `NATURES`/`deviceBeaconFor` constants. No behavior change — the DSC
  parsers and alerting stay in this plugin. Extracted so the forthcoming
  `signalk-ais-distress` plugin can share one implementation.

## [0.5.3]

### Added

- DSC distress **relays** are now recognised as relays (`relay: true`) across
  both the NMEA 0183 and NMEA 2000 (PGN 129808) paths, and narrated as a "DSC
  distress relay" naming the casualty rather than as a first-party alert.
- AIS device-beacon MMSIs (`970…` SART, `972…` MOB, `974…` EPIRB) are tagged
  with `deviceBeacon` so a direct DSC distress can be correlated with the
  matching AIS target.

### Fixed

- A distress relay now reads the nature of distress from the correct field
  (field 8) instead of the relay telecommand in field 3, and reports the
  casualty's MMSI rather than the relaying station's.

## [0.5.2]

### Added

- "Works well with" App Store entry recommending the Logbook plugin
  (`@meri-imperiumi/signalk-logbook`) via `signalk.recommends` — DSC call logs
  pair naturally with the on-vessel logbook.

### Fixed

- Restored the plugin-CI workflow pin after a bad Dependabot bump to a dead
  `signalk-server` ref had broken the cross-platform CI matrix shown on the App
  Store Indicators tab.

## [0.5.1]

### Fixed

- `dsc-call-markers` ResourceSets now carry `type: "ResourceSet"`, the
  discriminator Freeboard-SK requires (`isResourceSet()`). Without it the chart
  layer was served correctly but silently filtered out and rendered nothing.

## [0.5.0]

### Added

- New read-only `dsc-call-markers` resource (`/signalk/v2/api/resources/dsc-call-markers`):
  logged calls served as Freeboard-SK ResourceSets, one per category, as GeoJSON
  Point markers with nature / caller / time in the popup. Recency governed by the
  new `markerWindowHours` option (default 24); active distress stays until cleared.

## [0.4.0]

### Changed

- A **distress** caller's position is now emitted under the Search-and-Rescue
  context `sar.urn:mrn:imo:mmsi:<caller>` instead of `vessels.…`. Chartplotters
  (e.g. Freeboard-SK) render the `sar.` context as a distress/SaR target rather
  than an ordinary AIS vessel, so a received MAYDAY now stands out on the chart.
  Non-distress calls continue to report position under `vessels.…`.

## [0.3.0]

### Added

- Clear active DSC alarms: a PUT to `notifications.dsc.<category>` drops the live
  notification and marks the stored call so a server restart no longer re-raises it.
- New `clear-dsc` script / `npm run clear-dsc` (`--category distress|urgency|safety|all`).

## [0.2.0]

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

## [0.1.3]

### Fixed

- Logbook entries are written under the `radio` category (previously they
  defaulted to `navigation`).

## [0.1.2]

### Added

- `scripts/send-test-dsc.js` — inject a fake DSC distress/urgency/safety call
  via UDP without a radio. Configurable nature, MMSI, position, category, and
  target host/port.

## [0.1.1]

### Security

- Sanitise the DSC nature-of-distress code before it is used to build a
  notification path. A nature code arrives over the air unvalidated; left raw,
  a value such as `__proto__` or a dotted string could inject extra segments
  into the `notifications.<nature>` path that the server walks unguarded
  (SignalK/signalk-server#2768). Only a clean one- or two-digit code now reaches
  the path lookup; anything else collapses to `undesignated`.

## [0.1.0]

### Added

- Initial release. Receive, log, and alert on DSC (VHF digital selective
  calling) calls from NMEA 0183 (`$CDDSC`/`$CDDSE`) and NMEA 2000 (PGN 129808):
  distress, urgency, safety, and routine traffic.
- On-disk JSONL call log; call history served at
  `/signalk/v2/api/resources/dsc-calls` (anonymously readable under
  `allow_readonly`).
- Raises `notifications.dsc.<category>` under self (distress → emergency,
  urgency → alarm, safety → alert), with distress alerts re-announced across a
  server restart while still fresh.
- Optional GMDSS-style radio-log entry via signalk-logbook.
