# Upstream DSC distress-relay handling (fs=16) — design

**Target:** `SignalK/nmea0183-signalk`, new PR based on `upstream/master`.
**Tracking:** [signalk-dsc#2](https://github.com/sailingnaturali/signalk-dsc/issues/2) — the last unfiled item in the upstreaming checklist.
**Scope decision:** relay correctness only. No cancellation/ack state semantics (future PR if upstream wants it).

## Problem

The stock `DSC.ts` hook mis-handles DSC distress **relays** (a coast/ship station
re-broadcasting another vessel's distress — format specifier 16 all-ships, 20
individual, or 02 area, carrying category 12):

1. **Wrong nature.** A relay's field 3 is the relay telecommand (112), not a
   nature-of-distress code; the real nature is in field 8. The hook reads field 3
   and resolves every relay to `unassigned`.
2. **Wrong vessel.** The casualty's MMSI is in field 7 and the position in field 5
   is the *casualty's* — but the hook publishes `navigation.position` and the
   distress notification under the **relaying station's** context (field 1),
   attributing the distress to the wrong vessel.
3. **Ack char ignored.** Field 9 (R/B/S) is discarded.

Our `lib/dsc.js` already handles all of this (relay flag, `distressedMmsi`,
field-8 nature, ack char), with tested fixtures in `test/dsc.test.js:72-106`.

## Design

All changes inside the existing distress branch of `src/hooks/DSC.ts`; first-party
distress alerts (`parts[0] === '12'`) keep today's behavior exactly.

- **Relay detection:** `parts[2] === '12' && parts[0] !== '12'`.
- **Nature:** read from field 8 for relays, field 3 for first-party alerts. The
  inline nature switch is factored into a shared function taking the code — it
  stays switch-based (string-literal cases, default `unassigned`), so no
  prototype-pollution exposure from over-the-air values.
- **Casualty MMSI:** field 7, trailing zero stripped (10 digits → 9, same as
  field 1).
- **Attribution:** delta `context` = the casualty's
  `vessels.urn:mrn:imo:mmsi:<mmsi>`; `navigation.position` (field 5) and the
  distress notification are published there. The notification message names the
  relaying station's MMSI.
- **Empty field 7 fallback:** a relay may legitimately omit the casualty (vessel
  unknown). Fall back to the relaying station's context with the corrected
  nature and a "casualty unknown" message — a distress relay must never be
  silently dropped.
- **Ack char (field 9):** included in the notification message text only.

## Sequencing vs open PRs

Independent PR based on `upstream/master` (same pattern as
[#336](https://github.com/SignalK/nmea0183-signalk/pull/336) /
[#337](https://github.com/SignalK/nmea0183-signalk/pull/337), which touch the
same distress branch). Cross-fork PRs to SignalK must base on their `master`, so
stacking is not viable. Guaranteed merge conflict with #336 in the distress
switch — both PRs are ours; whoever lands second gets rebased by us. Note the
overlap in the PR description. Do **not** replicate #336's guards (position
regex, empty-MMSI bail) in this PR — that duplication is what creates avoidable
conflicts; rely on the rebase.

## Testing (TDD — failing tests first)

Port fixtures from `signalk-dsc/test/dsc.test.js` into upstream's `test/DSC.ts`
format:

- All-ships EPIRB relay `$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,12,,*00`:
  nature `epirb` (field 8, not `unassigned` from field 3), context = casualty
  `316200911`, position published under the casualty.
- First-party alert regression: `$CDDSC,12,3380400790,12,06,00,1423108312,2019,,,S,E*6A`
  unchanged (nature from field 3, sender context).
- Relay with empty field 7: falls back to relayer context, nature still from
  field 8, no throw.

## Process constraints

- PR title/body drafted for Bryan's review; posted only on explicit go
  (informal OSS tone; no internal plans/sequencing in the public text).
- After filing, tick the fs=16 checklist item in signalk-dsc#2's status comment.
