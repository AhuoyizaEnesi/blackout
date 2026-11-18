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
| REQ-10 | Persistent audit history and truthful postmortem | TBD | TBD | TBD | PLANNED |
| REQ-11 | Editorial, restrained responsive UI and accessibility | TBD | TBD | TBD | PLANNED |
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
