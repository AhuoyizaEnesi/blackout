# Requirements-to-evidence traceability

**Purpose:** Prevent steps, user requirements, and failure cases from disappearing in a long implementation. Before each release gate, map every critical requirement to code + test + observed behavior.

| Requirement ID | Source / decision | Implementation path | Automated test | Manual/live evidence | Status |
|---|---|---|---|---|---|
| REQ-01 | Create and join secure room | `src/game/lobby.ts`, `src/server/game/rooms.ts`, `src/schemas/team-schema.ts` (D-011) | `lobby.test.ts`, `rooms.test.ts` | `tests/team.spec.ts`, `tests/team-ui.spec.ts` on the local worker | TESTED (local) |
| REQ-02 | Role uniqueness and server-only authorization | `validateClaim` in `lobby.ts`; `rolesFor`, `decideApproval` in `src/server/game/commands.ts` | `lobby.test.ts`, `rooms.test.ts` (roles, approvals, forged requests) | Concurrent claims and forged requests on the local worker (`tests/team.spec.ts`) | TESTED (local) |
| REQ-03 | Deterministic incident state machine | `src/game/engine.ts` (D-009) | `src/game/engine.test.ts` | Complete run on local worker (`tests/simulation.spec.ts`) | TESTED (local) |
| REQ-04 | Four reachable exclusive endings | `evaluateOutcome`, `scoreBreakdown`, `RULES_VERSION` in `src/game/engine.ts` (D-009, D-010) | `engine.test.ts` (endings, truth table, score balance, rules version), `commands.test.ts` (full runs, legacy runs) | Complete Recovery and Escalation on local worker | TESTED (local)  |
| REQ-05 | Time events, server clock and deadline tie-breaking | `nextDue` in `src/game/engine.ts`; `run`, `settleSimulation` in `src/server/game/commands.ts`; `src/server/game/timer.ts`, `src/jobs.ts` (D-012) | `engine.test.ts` (time boundaries), `commands.test.ts` (incidents), `hardening.test.ts` (unattended settling, settle job) | Local worker: real-time deadline by late sync (2026-11-18 00:55) and with nobody connected (2026-11-18 13:20, `tests/hardening.spec.ts`); restart recovery | TESTED (local) |
| REQ-06 | Atomic/conflict-safe idempotent commands | `src/server/game/commands.ts`, `rooms.ts`, `record-store.ts` (D-008, D-011) | `commands.test.ts`, `rooms.test.ts` (concurrency, duplicates) | Concurrent requests from one and from three accounts on the local worker | TESTED (local, solo and team) |
| REQ-07 | Role-private clues never leaked to other clients | `findingFor`, `shareFinding` in `commands.ts`; `simulation_findings` in `team-schema.ts` | `rooms.test.ts` (findings) | Raw realtime sockets on the local worker (`tests/team.spec.ts`, room data test) | TESTED (local) |
| REQ-08 | Reconnect and recovery after client inactivity | `syncSimulation`, `syncRoom`; `simulation.tsx`, `team.tsx`, `src/lib/game-api.ts`, `src/components/ConnectionNotice.tsx` | `commands.test.ts`, `rooms.test.ts` (late sync, lost finding) | Refresh, closed tabs, offline and back, lost answer, ended session, delayed live updates on the local worker (`tests/simulation.spec.ts`, `tests/team-ui.spec.ts`, `tests/hardening.spec.ts`) | TESTED (local) |
| REQ-09 | Solo mode and 3-player collaboration | Solo: `simulation.tsx`; team: `team.tsx`, `rooms.ts` | `commands.test.ts`, `rooms.test.ts` | Complete solo run and complete three-person run on the local worker | TESTED (local); visual design pending |
| REQ-10 | Persistent audit history and truthful postmortem | `src/components/game/Postmortem.tsx`, `model.ts` (`annotate`), `RunLists.tsx`, `src/pages/(app)/(protected)/history.tsx` | `tests/ui.spec.ts` (score parts sum to score; history shows and reopens the run); engine unit tests for the four endings | `02_EVIDENCE_LOG.md` 2026-11-18 15:40 | TESTED locally (one ending driven through the page); not deployed |
| REQ-11 | Editorial, restrained responsive UI and accessibility | `src/styles.css` (tokens), `src/components/game/*`, `Navigation.tsx`, `PageHeader.tsx`, `Brand.tsx`, `src/pages/index.tsx` and the pages under `src/pages/(app)/` (D-013) | `tests/ui.spec.ts`, `tests/visual.spec.ts` (opt-in screenshots), existing `simulation.spec.ts`, `team-ui.spec.ts` | `02_EVIDENCE_LOG.md` 2026-11-18 15:40; `.deepspace/shots/` | TESTED locally in Chromium at three widths; screen reader and other browsers NOT RUN (R33) |
| REQ-12 | DeepSpace-native architecture and correct .app.space deploy | TBD | TBD | TBD | PLANNED |
| REQ-13 | Zero unapproved spend, protected secrets, owned Git commits | TBD | TBD | TBD | PLANNED |
| REQ-14 | Submission URLs and transparent agent disclosure | TBD | TBD | TBD | PLANNED |
| REQ-15 | Room lifecycle and abuse protection (Prompt 009, D-012) | `src/server/game/limits.ts`, `sweepRoom`/`sweepRooms` in `rooms.ts`, `src/cron.ts`, `src/server/realtime-routes.ts`, `src/server/action-routes.ts` | `hardening.test.ts` (expiry, sweep, limits) | Limits, expiry, deletion, route gates and tool routes on the local worker (`tests/hardening.spec.ts`) | TESTED (local) |

## Coverage loop
- When a requirement is added, create an ID before code work; link to phase step and decision record.
- When a feature lands, fill source path and actual test path, not placeholder success.
- On any major modification, inspect impacted requirements and rerun their tests.
- For a cut or deferral, mark `DEFERRED` with approval, rationale and writeup implication.
- At release gate, any unverified critical requirement is a blocker or an explicitly disclosed limitation.

## Prompt 012 coverage update (2026-11-18)
- REQ-09: solo and three-person play re-verified on the local worker (`simulation.spec`, `team.spec`, `team-ui.spec`); all four endings reached in real time (`tests/endings.spec.ts`).
- REQ-10: postmortem and history agree with the server for all four endings; the full event log is kept in an expandable section of the postmortem (D-014).
- REQ-11: D-014 corrections; accessibility assertions added to `tests/ui.spec.ts`; contrast computed (T50). Screen reader and second browser not done (R33).
- REQ-12: not started: nothing is deployed. Prerequisites checked: login valid, app registered, source unclaimed (R02), production build passes.
- REQ-13: no spend; no secret tracked; commits 704d027 and 17fa068 authored by the owner with no co-author trailer; Prompts 011, 011B and 012 are uncommitted.
- REQ-15: limits, expiry, route gates and tool routes re-run on the local worker (`hardening.spec`: 16 passed, 3 opt-in skipped).
