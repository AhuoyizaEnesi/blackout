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
