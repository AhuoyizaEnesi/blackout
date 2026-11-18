# Operation Nightfall — scenario baseline and rules needing proof

## Fixed narrative truth

At 07:42 a stolen admin credential yields a valid session; at 07:49 attacker modifies authentication configuration and accesses signing material; at 07:53 an unrelated deployment occurs; at 08:00 failures spike. The deployment is a plausible decoy. Restoring superficial health without containing both admin access and stolen signing material is not complete resolution.

## Initial state (proposed)

- Health: 82; containment: 20; trust: 64; evidence: 10 (each 0–100).
- Flags: compromised admin session = true; signing material exposed = true; admin revoked = false; keys rotated = false; service restored = false; recovery validated = false.
- Deadline: 480 seconds after server-authoritative start.

## Roles and actions (draft, not yet proven balanced)

| Role | Action | Preconditions / result | Duration |
|---|---|---|---:|
| Security | Inspect access logs | +15 evidence, admin clue | 15s |
| Security | Correlate session events | Logs inspected; +20 evidence, session compromise confirmed | 20s |
| Security | Revoke admin sessions | Correlation + commander approval; +40 containment, revoked=true | 25s |
| Security | Investigate signing-material access | Correlation; +25 evidence, exposure found | 20s |
| Security | Validate containment | Admin revoked; +10 evidence; surface remaining risk | 15s |
| Infrastructure | Review deployment | +10 evidence; reveal unrelated rollout | 15s |
| Infrastructure | Roll back release | Commander approval; +18 health; possible -4 trust if security already established | 30s |
| Infrastructure | Rotate signing keys | Exposure found + approval; +35 containment, -3 trust, rotated=true | 35s |
| Infrastructure | Restore auth | Admin revoked + keys rotated; +35 health; restored=true | 40s |
| Infrastructure | Validate recovery | Service restored; +10 health, validated=true | 20s |
| Commander | Issue customer advisory | One-time +8 trust; prevent separate communication penalty | 15s |
| Commander | Confirm resolution | Recovery validated and full success criteria; immediate terminal outcome | 0s |

**Clarification required in E07/E08:** the count above is 12 operational actions, while commander approvals are separate workflow commands. Approvals require separate 5-second processing semantics, precise request IDs and actor rules. Solo approvals can be auto-recorded. The decision whether to allow *deny* must be implemented consistently with this model.

## Timed events (draft)

| Elapsed | Condition | Effect |
|---|---|---|
| 00:00 | Always | Initial alert |
| 01:00 | Service not restored | Health -8, trust -5 |
| 02:00 | Not contained | Containment -5; admin activity warning |
| 03:00 | Service not restored | Health -10, trust -5 |
| 04:00 | Admin session active | Containment -10; signing exposure clue |
| 05:30 | Keys not rotated | Trust -8 for replay; additionally -5 communication if no advisory |
| 07:00 | Always | Deadline warning |
| 08:00 | Always | Finalization after same-time completions |

## Endings (ordered draft)

1. **Complete Recovery:** fully contained, restored, validated, health >=70, trust >=40.
2. **Costly Recovery:** fully contained and restored but one or more complete criteria missed.
3. **Partial Containment:** at least one containment intervention completed, but threat+service not both resolved.
4. **Incident Escalation:** neither containment intervention succeeded.

**OPEN ISSUE:** If both interventions complete but service is not restored, neither #3's old wording nor #4 applies. Fix by defining `Partial Containment` as *any* successful containment intervention when not eligible for the first two, or introduce a separate condition; then prove exhaustive partition. Do not implement the incomplete wording literally.

## Scoring (draft 100 points)

- 30 fully contained; 25 service restored; 15 recovery validated; 10 critical evidence (5 admin session + 5 signing exposure); 10 floor(trust/10), capped; 10 floor(health/10), capped.
- No credit for actions merely attempted; events must be durable.

## Engine invariants

- One use per action, role busy while timed operation runs, approved requests scoped to exact operation; no repeated points.
- Server time and persisted timestamps; no browser-authoritative clock.
- Events processed in fixed order; late requests rejected, exact-deadline completions processed before terminal evaluation.
- All outcomes mathematically reachable, complete paths within eight minutes, no hidden data leakage.
- These are preliminary rules, subject to Phase E simulation/proof before code freeze.

## Reconciled rules (D-009) — implemented and tested 2026-11-17

Everything above is the original draft and is kept unchanged. This section records how each open point was settled in `src/game/engine.ts`. Status: implemented and unit-tested; awaiting owner acceptance.

**Amended 2026-11-18 by D-010:** the subsections "Endings", "Score" and "Facts established by the tests" below describe the unversioned D-009 rules and are superseded by "Rules version 2" at the end of this document. The action catalog, approval rules and incident schedule below are unchanged and current.

### Action catalog (12 actions; identifiers are stable)

| Role | Id | Requires (completed) | Approval | Duration | Effect on completion |
|---|---|---|---|---:|---|
| Security | `inspect_access_logs` | — | no | 15s | evidence +15 |
| Security | `correlate_session_events` | inspect_access_logs | no | 20s | evidence +20; critical finding 1 |
| Security | `investigate_signing_access` | correlate_session_events | no | 20s | evidence +25; critical finding 2 |
| Security | `revoke_admin_sessions` | correlate_session_events | yes | 25s | containment +40; intervention 1 |
| Security | `validate_containment` | revoke_admin_sessions | no | 15s | evidence +10 |
| Infrastructure | `review_deployment` | — | no | 15s | evidence +10 |
| Infrastructure | `roll_back_release` | — | yes | 30s | health +18; trust -4 if ordered after critical finding 1 |
| Infrastructure | `rotate_signing_keys` | investigate_signing_access | yes | 35s | containment +35, trust -3; intervention 2 |
| Infrastructure | `restore_auth` | revoke_admin_sessions, rotate_signing_keys | no | 40s | health +35; service restored |
| Infrastructure | `validate_recovery` | restore_auth | no | 20s | health +10; recovery validated |
| Commander | `issue_customer_advisory` | — | no | 15s | trust +8 |
| Commander | `confirm_resolution` | revoke, rotate, restore_auth, validate_recovery | no | instant | ends the simulation |

Each action can be used once. A role runs one timed action at a time. Metrics are clamped to 0..100. Nothing happens after the deadline: an action that would finish later never completes and earns nothing.

### Commander approval (pure engine rules; multiplayer authorization not built)

- Gated actions: `revoke_admin_sessions`, `roll_back_release`, `rotate_signing_keys`.
- Request: only by the role that performs the action, only once its other prerequisites are met, not while a request is pending or already approved.
- Decision (approve or deny): commander only, only on a pending request. It takes effect 5 seconds after it is recorded. It does not occupy the commander role.
- Denial: blocks the action; once it has taken effect the role may request again.
- An approval is scoped to its exact action and is spent by running it.
- Solo: request and approval are recorded as one event (`approval_auto_granted`); the 5 seconds still apply.

### Scheduled incidents

| Elapsed | Id | Applies when | Effect |
|---|---|---|---|
| 00:00 | `initial_alert` | always | none |
| 01:00 | `service_degradation` | service not restored | health -8, trust -5 |
| 02:00 | `attacker_activity` | not fully contained (either intervention missing) | containment -5 |
| 03:00 | `outage_spreads` | service not restored | health -10, trust -5 |
| 04:00 | `attacker_escalation` | admin sessions not revoked | containment -10 |
| 05:30 | `token_replay` | signing keys not rotated | trust -8 |
| 05:30 | `communication_gap` | no advisory issued | trust -5 |
| 07:00 | `deadline_warning` | always | none |
| 08:00 | `finalization` | always | ends the simulation |

Every incident is recorded at its exact time whether or not its penalty applies. Same-millisecond order: incidents, then action completions (catalog order), then finalization. So an advisory finishing at exactly 05:30 is too late, and an action finishing at exactly 08:00 counts.

### Endings (checked in this order; every final state has exactly one)

1. **Complete Recovery** — both interventions, service restored, recovery validated, health >= 70, trust >= 40.
2. **Costly Recovery** — both interventions and service restored, but not all of the above.
3. **Partial Containment** — at least one intervention, without a restored service. Includes both interventions with the service never restored (the draft's OPEN ISSUE).
4. **Incident Escalation** — neither intervention.

The run ends at the deadline, or earlier when the commander confirms resolution. The ending is the same function of state either way.

### Score (0..100)

30 both interventions; 25 service restored; 15 recovery validated; 5 session compromise confirmed; 5 signing exposure found; floor(trust/10) up to 10; floor(health/10) up to 10. Credit is for completed work only.

### Facts established by the tests (not rule choices)

- Fastest complete recovery: 155 seconds. A solo player needing 20 seconds per decision still confirms by 410 seconds.
- The 01:00 penalty cannot be avoided (restoration takes at least 135 seconds), and rotation always costs 3 trust, so trust cannot exceed 64 on a restored run: **the highest attainable score is 96**.
- Once the service is restored health is at least 99, so the health >= 70 condition never decides an ending, and Validate recovery's +10 health shows as at most +1.
- A Costly Recovery can score 93 (slow, silent, but fully validated); the score separates endings weakly at the top.

## Rules version 2 (D-010) — implemented and tested 2026-11-18

Current specification for endings and score. Everything else (actions, approvals, incidents, ordering) is as in "Reconciled rules (D-009)" above. `RULES_VERSION` in `src/game/engine.ts` is 2. Status: implemented and tested locally; awaiting owner acceptance.

### Endings (checked in this order; every final state has exactly one)

1. **Complete Recovery** — both interventions, service restored, recovery validated, trust >= 40.
2. **Costly Recovery** — both interventions and service restored, but not validated, or trust below 40.
3. **Partial Containment** — at least one intervention, without a restored service.
4. **Incident Escalation** — neither intervention.

There is no health condition. Health is at least 99 whenever the service is restored (worst case 82 - 8 - 10 + 35), so the draft's health >= 70 could never fail. Restoring the service is the health criterion.

### Score (0..100)

| Component | Points |
|---|---:|
| Admin sessions revoked | 15 |
| Signing keys rotated | 15 |
| Authentication service restored | 25 |
| Recovery validated | 15 |
| Session compromise confirmed | 5 |
| Signing exposure found | 5 |
| Trust retained | 0–10 |
| Health | 0–10 |

- **Trust retained:** 10 if trust is at its starting level (64) or higher; one point less for every 6 trust lost, counting a started step (64 → 10, 63–58 → 9, 57–52 → 8, 51–46 → 7, 45–40 → 6, 39–34 → 5, … 9 or less → 0).
- **Health:** floor(health / 10), at most 10.
- Credit is for completed work only. Confirming resolution ends the run; it is not worth points.

### Score bands (each proven by a named best and worst play, and checked on 1,500 varied plays)

| Ending | Lowest | Highest |
|---|---:|---:|
| Incident Escalation | 12 | 26 |
| Partial Containment | 32 | 57 |
| Costly Recovery | 79 | 95 |
| Complete Recovery | 96 | 100 |

The bands do not overlap, so a better ending always scores higher than a worse one.

### The perfect run (100)

Investigate (inspect, correlate, signing access), revoke and rotate with approval, restore before 03:00, validate, and issue the customer advisory. Fastest: confirmed at 155 seconds. What it costs to deviate: no advisory 98; service restored after 03:00 99; rollback ordered after the diagnosis 99; not validated 85 (Costly Recovery).

### Rules version

- Every simulation stores the rules version it was created under (`rulesVersion`, immutable, set by the server).
- A simulation with no version or a different version is refused by every server command with `rules_version_unsupported`, before its event log is read: it is never replayed, re-scored or extended. The page lists it as "earlier rules — cannot be opened".
- A unit test pins a digest of the rulebook (catalog, schedule, constants, trust table, and the full logs and results of the eight named strategies) to the version number. Changing a rule without bumping `RULES_VERSION` fails that test.

### Known and left as is

- A rollback ordered before the diagnosis is free: it neither helps nor hurts a perfect run. It is never required and never raises a score that containment and restoration have not already maxed.
- Validate recovery's +10 health is almost always clamped away at 100. Its value is the flag: 15 points and eligibility for Complete Recovery.
- The best Costly Recovery (95) sits one point under the worst Complete Recovery (96). They differ by which side of trust 40 the run ended on.

## Team play (D-011) — implemented and tested 2026-11-18

No action, duration, prerequisite, effect, incident, ending or score rule changed for team play; `RULES_VERSION` is still 2 and a team playing the solo optimal line reaches the same result (Complete Recovery, 100). What differs from solo:

- **Roles.** Three participants, one role each, fixed when the host starts. Each participant can start only their own role's actions. "Role busy" now applies per person.
- **Approvals.** The three gated actions (revoke admin sessions, roll back release, rotate signing keys) need a real decision: the role that will run the action asks, the Incident Commander approves or denies that specific request, and the decision takes the usual 5 seconds to come into effect. A denied request may be made again once the denial is in effect. A request has no time limit: it waits for the commander until the simulation ends.
- **Findings.** Incident reports and the closing confirmation are shown to all three. What an action reveals is shown to the participant who ran it, who may share it with the team. Sharing is free, is allowed at any time, and does not change metrics, the ending or the score.
- **Start.** The eight-minute clock starts when the host starts the room, not when the room is created.
