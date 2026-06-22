# Changelog

All notable changes to `@sailingnaturali/signalk-dsc` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
