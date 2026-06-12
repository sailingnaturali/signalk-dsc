# Changelog

All notable changes to `@sailingnaturali/signalk-dsc` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
