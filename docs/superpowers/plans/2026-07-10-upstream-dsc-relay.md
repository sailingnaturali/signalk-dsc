# Upstream DSC Distress-Relay (fs=16) PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `SignalK/nmea0183-signalk`'s DSC hook so distress relays (all-ships/individual/area format carrying category 12) are attributed to the casualty with the correct nature of distress, and file it as an upstream PR.

**Architecture:** All changes live in the existing distress branch of `src/hooks/DSC.ts` in the local fork clone at `~/src/sailingnaturali/nmea0183-signalk` (origin = `clarkbw/nmea0183-signalk`, upstream = `SignalK/nmea0183-signalk`). The nature-of-distress switch is factored into a module-level function used by both the first-party and relay paths. Spec: `signalk-dsc/docs/superpowers/specs/2026-07-10-upstream-dsc-relay-design.md`.

**Tech Stack:** TypeScript, mocha + chai (`should` style with a `containItemWithProperty` helper), prettier (no semicolons, single quotes).

## Global Constraints

- Branch `dsc-distress-relay` from `upstream/master`; do NOT include or replicate anything from open PRs #336/#337 (no position regex guard, no empty-sender-MMSI bail) — the expected merge conflict with #336 is resolved by rebase later, not by duplication.
- First-party distress alerts (`parts[0] === '12'`) must keep today's behavior byte-for-byte (existing tests must pass unmodified).
- The existing first-party message string `'DSC Distress Recieved! ...'` (typo and all) stays untouched.
- Code style: match the file (`var` locals, no semicolons, single quotes); run `npm run prettier` before committing.
- **Outbound text gate:** the PR is opened and the issue comment edited ONLY after Bryan approves the drafted text (informal OSS tone; no internal plans/sequencing in public text).
- Fixture sentences need valid NMEA checksums — the parser validates them. Use the exact sentences given below (checksums already computed).

---

### Task 1: Relay recognition — nature from field 8, casualty attribution

**Files:**
- Modify: `src/hooks/DSC.ts` (distress branch of the `switch (parts[2]!)`, nature switch at `case '12'`, notification push, ~lines 89–190)
- Test: `test/DSC.ts`

**Interfaces:**
- Produces: module-level `function natureOfDistress(code: string | undefined): string` in `src/hooks/DSC.ts` (same code→name mapping as the current inline switch, default `'unassigned'`); hook-local `var relayedBy: string | undefined` that Task 2 relies on.

- [ ] **Step 1: Set up the branch**

```bash
cd ~/src/sailingnaturali/nmea0183-signalk
git fetch upstream
git checkout -b dsc-distress-relay upstream/master
npm ci
```

- [ ] **Step 2: Write the failing tests**

Add to `test/DSC.ts`, after the `nmeaLineUrgency` constant:

```typescript
// A distress *relay*: a coast station (field 1) re-broadcasts another
// vessel's distress as an all-ships call (format 116). Field 3 is the relay
// telecommand (112), not a nature code — the nature (12 = EPIRB) is in
// field 8 and the casualty's MMSI in field 7. The position in field 5 is
// the casualty's.
const nmeaLineRelay =
  '$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,12,,*47'
```

Add to the `describe('DSC', ...)` block:

```typescript
it('Distress relay reads the nature from field 8, not the relay telecommand', () => {
  const delta = new Parser().parse(nmeaLineRelay) as any

  delta.updates[0]!.values.should.containItemWithProperty(
    'path',
    'notifications.epirb'
  )
})

it('Distress relay is attributed to the casualty, not the relaying station', () => {
  const delta = new Parser().parse(nmeaLineRelay) as any

  delta.context.should.equal('vessels.urn:mrn:imo:mmsi:316200911')
  delta.updates[0]!.values.should.containItemWithProperty(
    'path',
    'navigation.position'
  )
})

it('Distress relay notification names the relaying station', () => {
  const delta = new Parser().parse(nmeaLineRelay) as any

  const notification = delta.updates[0]!.values.find(
    (v: any) => v.path === 'notifications.epirb'
  )
  notification.value.message.should.contain('003160001')
})
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx mocha --grep 'Distress relay'`
Expected: 3 failing. The nature test fails because field 3 (`112`) resolves to `notifications.unassigned`; the attribution test fails with context `vessels.urn:mrn:imo:mmsi:003160001` (the relayer).

- [ ] **Step 4: Implement**

In `src/hooks/DSC.ts`, add a module-level function above `const DSC: HookFn` (this is the current inline nature switch, moved verbatim):

```typescript
function natureOfDistress(code: string | undefined): string {
  switch (code) {
    case '00': // = Fire, explosion
      return 'fire'
    case '01': // = Flooding
      return 'flooding'
    case '02': // = Collision
      return 'collision'
    case '03': // = Grounding
      return 'grounding'
    case '04': // = Listing, in danger of capsize
      return 'listing'
    case '05': // = Sinking
      return 'sinking'
    case '06': // = Disabled and adrift
      return 'adrift'
    case '07': // = Undesignated distres
      return 'undesignated'
    case '08': // = Abandoning ship
      return 'abandon'
    case '09': // = Piracy/armed robbery attack
      return 'piracy'
    case '10': // = Man overboard
      return 'mob'
    case '12': // = EPRIB emission
      return 'epirb'
    default:
      // unassigned symbol; take no action
      return 'unassigned'
  }
}
```

Add `var relayedBy: string | undefined` next to the other hook locals (`handled`, `get_position`, …), then replace the whole `case '12':` branch (including its inline nature switch) with:

```typescript
    case '12': // * 112 = distress
      handled = true
      get_position = true
      distress = true
      if (parts[0] !== '12') {
        // A distress *relay* (all-ships 116, individual 120 or area 102
        // format carrying the distress category): field 3 holds the relay
        // telecommand, not a nature code — the nature is in field 8 and the
        // casualty's MMSI in field 7. The position in field 5 is the
        // casualty's, so the delta is attributed to the casualty, not to
        // the relaying station.
        distress_nature = natureOfDistress(parts[8])
        relayedBy = mmsi
        if (!isEmpty(parts[7])) {
          mmsi = parts[7]!.substring(0, 9)
        }
      } else {
        distress_nature = natureOfDistress(parts[3])
      }
  }
```

(The `var mmsi` reassignment is what moves both `navigation.position` and the notification to the casualty's context in the `return`.)

Replace the `if (distress) { ... }` push with:

```typescript
  if (distress) {
    var message =
      'DSC Distress Recieved! Nature of distress: ' + distress_nature
    if (relayedBy !== undefined) {
      var casualty = relayedBy === mmsi ? 'an unknown vessel' : 'vessel ' + mmsi
      message =
        'DSC distress relay received for ' +
        casualty +
        ' (relayed by ' +
        relayedBy +
        '). Nature of distress: ' +
        distress_nature
      var ack = typeof parts[9] === 'string' ? parts[9]!.trim() : ''
      if (ack !== '') {
        message += '. Acknowledgement: ' + ack
      }
    }
    values.push({
      path: 'notifications.' + distress_nature,
      value: {
        message: message
      }
    })
  }
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npm test`
Expected: all pass, including every pre-existing DSC test (first-party behavior unchanged) and the 3 new relay tests.

- [ ] **Step 6: Typecheck, format, commit**

```bash
npm run typecheck && npm run prettier && git diff --stat
git add src/hooks/DSC.ts test/DSC.ts
git commit -m "fix(DSC): attribute distress relays to the casualty, not the relaying station"
```

---

### Task 2: Empty-casualty fallback

**Files:**
- Modify: `src/hooks/DSC.ts` (only if Step 3 reveals a failure — Task 1's `isEmpty(parts[7])` guard is expected to already cover this)
- Test: `test/DSC.ts`

**Interfaces:**
- Consumes: Task 1's `relayedBy` local and the `isEmpty(parts[7])` guard in the relay branch.

- [ ] **Step 1: Write the failing/pinning test**

Add to `test/DSC.ts` next to `nmeaLineRelay`:

```typescript
// A relay may legitimately omit the casualty's MMSI (vessel unknown). It
// must fall back to the relaying station's context — never be dropped.
const nmeaLineRelayNoCasualty =
  '$CDDSC,16,0031600010,12,112,00,1423108312,2019,,12,,*48'
```

And in the `describe` block:

```typescript
it('Distress relay without a casualty MMSI falls back to the relaying station', () => {
  const delta = new Parser().parse(nmeaLineRelayNoCasualty) as any

  delta.context.should.equal('vessels.urn:mrn:imo:mmsi:003160001')
  delta.updates[0]!.values.should.containItemWithProperty(
    'path',
    'notifications.epirb'
  )
  const notification = delta.updates[0]!.values.find(
    (v: any) => v.path === 'notifications.epirb'
  )
  notification.value.message.should.contain('unknown vessel')
})
```

- [ ] **Step 2: Run it**

Run: `npx mocha --grep 'without a casualty'`
Expected: PASS (Task 1's guard covers it — this test pins the behavior). If it fails instead, fix the relay branch so an empty field 7 leaves `mmsi` untouched, matching Task 1 Step 4's code exactly.

- [ ] **Step 3: Full suite + commit**

```bash
npm test && npm run typecheck && npm run prettier
git add test/DSC.ts
git commit -m "test(DSC): pin relay fallback when the casualty MMSI is absent"
```

---

### Task 3: Push branch and draft the PR for Bryan

**Files:**
- Create: PR draft text (in the conversation, copy-pasteable block — NOT posted)

**Interfaces:**
- Consumes: the `dsc-distress-relay` branch from Tasks 1–2.

- [ ] **Step 1: Push the branch to the fork** (our fork, not outbound)

```bash
git push -u origin dsc-distress-relay
```

- [ ] **Step 2: Draft the PR title and body**

Present to Bryan in a copy-pasteable block. Content requirements:

- Title: `Attribute DSC distress relays to the casualty and read the real nature of distress`
- Informal OSS tone (msallin has been reviewing; Bryan knows the room). No internal roadmap/sequencing.
- Body covers: what a relay sentence looks like (use `$CDDSC,16,0031600010,12,112,00,1423108312,2019,3162009110,12,,*47` as the worked example); the three bugs (nature read from the telecommand field → always `unassigned`; casualty's position + notification published under the relaying station's context; ack char dropped); what the fix does (field 8 nature via the extracted `natureOfDistress()`, field 7 casualty context with trailing-zero strip, relayer + ack char in the message); the empty-field-7 fallback; a note that it overlaps #336 in the same switch and we're happy to rebase whichever lands second.

- [ ] **Step 3: Wait for Bryan's explicit go** — do not run `gh pr create` before it.

- [ ] **Step 4 (on go): Open the PR**

```bash
gh pr create --repo SignalK/nmea0183-signalk \
  --head clarkbw:dsc-distress-relay \
  --title '<approved title>' --body '<approved body>'
```

- [ ] **Step 5 (on go): Tick the checklist in signalk-dsc#2**

Edit our status comment (id `4934988636`) on `sailingnaturali/signalk-dsc#2`: change the `- [ ] Relay/ack (fs=16) handling — not yet filed, follow-up PR.` line to a checked item linking the new PR number, matching the style of the other three lines. Use:

```bash
gh api -X PATCH repos/sailingnaturali/signalk-dsc/issues/comments/4934988636 -f body='<full updated body>'
```

(Fetch the current body first with `gh api repos/sailingnaturali/signalk-dsc/issues/comments/4934988636 --jq .body`, edit only that one line.)

---

## Self-Review

- **Spec coverage:** relay detection (T1 S4), field-8 nature via shared switch (T1 S4), casualty context + trailing-zero strip (T1 S4), relayer named in message (T1 S4 + test S2), ack char in message (T1 S4), empty-field-7 fallback (T2), no #336 guard duplication (Global Constraints), TDD fixtures ported (T1 S2/T2 S1), PR gate + issue tick (T3). No gaps.
- **Placeholders:** `<approved title>`/`<approved body>` are deliberate — they are Bryan-gated inputs, not missing content; the draft requirements are fully specified in T3 S2.
- **Type consistency:** `natureOfDistress(code: string | undefined): string` matches both call sites; `relayedBy: string | undefined` consistent across T1/T2.
