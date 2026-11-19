# Session handoff — resume anchor

**Status:** Operation Nightfall (rules version 2) is playable solo and as a three-person team with a complete designed interface: landing, setup, lobby, command center, evidence, postmortem and history. Backend foundation committed and pushed (17fa068); the interface (Prompt 011, D-013) is in the working tree, tested locally, uncommitted. Never deployed.
**Updated:** 2026-11-18
**Current step:** Phase C partially evidenced (C01, C03, C04, C11–C13); Phase A–C gates not formally closed.
**Current phase gate:** Phase C
**Last verified repository revision:** 17fa068 on `main` = `origin/main` (Prompt 010 checkpoint). Prompt 011 interface work and tracker edits are uncommitted working-tree changes on top of it.
**Live DeepSpace URL:** NONE
**Current blocker:** None technical. D-008 to D-013 await the owner's acceptance. `deepspace test run` is broken locally (F-003); use the direct Playwright command in `02_EVIDENCE_LOG.md`. One API test is flaky by its own race (F-007).
**Next action:** Owner reviews the screens (run locally, or open the images in `.deepspace/shots/` after `BLACKOUT_SHOTS=1`), accepts or revises D-013, commits. After that: manual accessibility pass (R33), first deploy and deployed smoke test (rooms, timer and sweep logs, R27, R35).
**Owner input needed now:** Accept or amend D-013 and the two font packages; decide the F-007 test fix; commit the interface; confirm that reviewers signing in with GitHub or Google is acceptable.

## Checkpoint record — 2026-11-17 (Claude Code, Prompts 001–003)
- Checkpoint timestamp/timezone: 2026-11-17, about 22:20 US Central
- Step IDs completed or blocked: C01, C03, C04, C11 (static checks only), C12, C13 evidenced; none blocked
- Repo/branch/commit or working-tree revision: `main` at 704d027 plus uncommitted scaffold
- Exact paths changed: scaffold files at repo root; `wrangler.toml`; `.gitignore`; `blackout flow/01_PROGRESS.md`, `02_EVIDENCE_LOG.md`, `14_SESSION_HANDOFF.md`
- Claude Code version/model **observed**: Claude Code CLI 2.1.327 (global npm listing); model id reported by the session: claude-fable-5-2
- Commands and tests actually run; pass/fail/skipped: `tsc --noEmit` pass; `eslint .` pass; `vitest run` pass (3 tests); `vite build` pass; Playwright suites skipped
- URLs/screenshots/logs/evidence refs: `02_EVIDENCE_LOG.md`
- SDK versions/API assumptions verified: `deepspace` 0.44.2. `app init` verified in CLI source to commit only when the repo has no commits; it made none here. Auth, permissions, server actions, rooms, presence and cron are verified from docs.deep.space only
- Decisions taken and approvals received: owner directed pnpm, scaffold, registration and `.env` exclusions via Prompts 002–003
- Critical risks unresolved: R01 (no documented multi-record transaction; plan is one-write commits, untested), R03, R06, R08
- What the assistant can do next without user input: read the generated `src/server/*` routes and SDK `.d.ts` files to close C05–C10 against real code
- What the owner alone must do: git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-17, about 22:55 US Central (Claude Code, Prompt 003 re-issued)
- Step IDs completed or blocked: C11–C13 re-verified; nothing new completed
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed in this pass: `blackout flow/01_PROGRESS.md`, `02_EVIDENCE_LOG.md`, `14_SESSION_HANDOFF.md` only
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vitest run` pass (4 files, 44 tests); `vite build` pass; read-only `deepspace auth whoami`, `app list`, `app source`, `status`, `app usage`. `app init` not rerun. Playwright suites skipped
- Registration: unchanged — `app_01M7PE4DPM9P0NYXQG430BJT9A`, never deployed, source unclaimed, free tier 0/500 credits used
- **Stale statement above:** "no BLACKOUT features built" is no longer true of the working tree. Feature code dated 22:26–22:31 exists (`src/game/`, `src/server/game/`, simulation schema/page/API client, `tests/simulation.spec.ts`) with no tracker entry (F-002 in `02_EVIDENCE_LOG.md`). It was not reviewed in this pass
- What the owner alone must do: say where that code came from; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-17, about 23:15 US Central (Claude Code, Prompt 005)
- Step IDs completed or blocked: first vertical slice reviewed and TESTED locally; not VERIFIED LIVE; none blocked
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed in this pass: `tests/simulation.spec.ts` (one reconnect test added); `blackout flow/01_PROGRESS.md`, `02_EVIDENCE_LOG.md`, `03_DECISIONS.md`, `10_RISKS_AND_OPEN_QUESTIONS.md`, `14_SESSION_HANDOFF.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vitest run` 44/44; `vite build` pass; `npx deepspace test run all` FAILED twice (11 sign-in failures, F-003); `npx playwright test --config tests/playwright.config.ts` 26/26
- SDK versions/API assumptions verified: deepspace 0.44.2 — synchronous `putRecord` with `uniqueOn` and `immutable` on server-action writes, `Duplicate:` error prefix, `read: 'own'` filtering on queries and broadcasts, agent tools run with permissions on. All read in `node_modules/deepspace/dist/worker.js`
- Code path (for interview): `simulation.tsx` → `callGameAction` (bearer token) → `POST /api/actions/:name` (`action-routes.ts`, JWT verified) → `src/actions/index.ts` (server clock) → `commands.ts` (ownership check, idempotency, validate with `engine.ts`) → `record-store.ts` (one insert into `simulation_events`) → room broadcasts the new row to the owner's sockets → page folds the log with the same reducer
- One real tradeoff: lazy completion instead of a server alarm (D-008)
- One failure case and its test: 12 simultaneous different commands for the same action → exactly one starts it (`tests/simulation.spec.ts`, "concurrent submissions")
- Decisions taken and approvals received: D-008 recorded as Proposed; no owner approval yet
- Critical risks unresolved: R01 (partly mitigated), R03, R06, R08, plus new R17, R18
- What the assistant can do next without user input: nothing further on this slice
- What the owner alone must do: accept or revise the slice; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-17, about 23:55 US Central (Claude Code, Prompt 006)
- Step IDs completed or blocked: full scenario engine IMPLEMENTED and TESTED locally (E06–E13, E15–E18, H01–H15 worked; gates not formally closed); not VERIFIED LIVE; none blocked
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed: see the 23:55 checkpoint in `01_PROGRESS.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vite build` pass; `vitest run` 145/145; Playwright (direct) fast set rerun after all changes: 27 passed, 1 failed, 1 skipped — the failure is the scaffold test `collab.spec.ts:65` (API status page), which is intermittent (passed 2 of 3 immediate reruns, F-004); all 18 runnable BLACKOUT tests passed; slow set: PASS: 2 passed, 0 failed, exit 0 (complete solo run 2.8 min; real-time eight-minute deadline run 8.0 min; 11.6 min total)
- Rules: `05_SCENARIO_BASELINE.md` section "Reconciled rules (D-009)" is the current specification; `src/game/engine.ts` is its implementation
- Code path (for interview): command → `run()` in `commands.ts` reads the log, writes every system event owed up to now in the order `nextDue` gives (incidents, then completions), validates the command with the engine, appends one event; the page folds the same log with the same reducer. Hidden text is added to events by the server from `scenario-secrets.ts`
- One real tradeoff: system events are written lazily but validated strictly — `applyEvent` rejects any log in which a system event is missing, early or out of order, so lateness cannot change the result. The price is that a rule change invalidates stored logs (R21)
- One failure case and its test: an advisory finishing at exactly 05:30 does not prevent the silence penalty, one millisecond earlier it does (`engine.test.ts`, "on the same millisecond an incident fires before an action completes")
- Decisions taken and approvals received: D-009 recorded as Proposed; no owner approval yet
- Critical risks unresolved: R01 (partly mitigated), R06, R08, plus R17–R21; open follow-ups F-003 (`deepspace test run` unusable locally) and F-004 (intermittent scaffold test)
- What the assistant can do next without user input: nothing further in this scope
- What the owner alone must do: accept or amend D-008/D-009; decide R20; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-18, about 00:55 US Central (Claude Code, Prompt 007)
- Step IDs completed or blocked: engine stabilization IMPLEMENTED and TESTED locally; not VERIFIED LIVE; none blocked
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed: see the 00:55 checkpoint in `01_PROGRESS.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vite build` pass; `vitest run` 171/171; Playwright (direct) fast set 30 passed, 1 skipped; API status tests 30/30 over 15 repeats; slow deadline test: PASS: 1 passed, 0 failed, exit 0 (8.1 min; idle run ended as Incident Escalation with score 12)
- Rules: `05_SCENARIO_BASELINE.md` section "Rules version 2 (D-010)" is the current specification for endings and score; the D-009 section is current for actions, approvals and incidents
- Code path (for interview): `loadForMember` in `commands.ts` checks ownership, then the simulation's `rulesVersion` against `RULES_VERSION`, before any event is read; `scoreBreakdown` and `trustScore` in `engine.ts` compute the score from the folded state
- One real tradeoff: old runs are refused outright instead of migrated or shown read-only. That is the only option that cannot mis-score a log, and costs nothing before launch; after launch it would hide finished runs on every rule change (R21)
- One failure case and its test: a row with no rules version is refused by sync, execute and approval, and nothing is appended to it (`commands.test.ts`, "rules version: simulations recorded under other rules"; also `tests/simulation.spec.ts` against real old local rows)
- Decisions taken and approvals received: D-010 recorded as Proposed; no owner approval yet
- Critical risks unresolved: R01 (partly mitigated), R06, R08, R17–R19; R20 addressed and R21 mitigated pending acceptance; F-003 open; F-004 closed
- What the assistant can do next without user input: nothing further in this scope
- What the owner alone must do: accept or amend D-008/D-009/D-010; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-18, about 02:50 US Central (Claude Code, Prompt 008)
- Step IDs completed or blocked: multiplayer rooms, roles, approvals and team synchronization IMPLEMENTED and TESTED locally; not VERIFIED LIVE; none blocked
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed: see the 02:50 checkpoint in `01_PROGRESS.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vite build` pass; unit: PASS: 6 files, 235 tests, 0 failed (232 BLACKOUT, 3 scaffold; 64 new: lobby 17, rooms and team play 47); Playwright (direct), full regression: PASS: 44 passed, 1 skipped (the eight-minute test), 0 failed, exit 0 (5.1 min; third run — the first two each failed on defects in the new tests, see F-005); concurrency tests repeated: PASS: 15 passed, 0 failed (5 tests, 3 times each, 2.2 min)
- Architecture: D-011 in `03_DECISIONS.md`; gate evidence at the end of `06_ARCHITECTURE_GATES.md`; team rules summary at the end of `05_SCENARIO_BASELINE.md`
- Code path (for interview): a click on "Take role" calls `claimRole` in `src/server/game/rooms.ts`, which folds the room's lobby log (`reduceLobby`), asks `validateClaim`, and appends one `role_claimed` event at `lastSeq + 1`; a second claimant's insert at the same position is refused by `uniqueOn`, so it re-reads and is told `role_taken`. Game commands get the caller's role from that log through `rolesFor` in `commands.ts`
- One real tradeoff: game roles are not SDK roles. RecordRoom can say who may read a row, not who is the commander, so roles live in an app-level log and every server action checks them itself. It costs a log read per command and buys rules that are testable without the SDK
- One failure case and its test: the commander approves and denies the same request from two tabs at once — exactly one decision is recorded and the other is told the request is no longer pending (`rooms.test.ts`, "records exactly one decision…"; `tests/team.spec.ts`, roles and approvals test)
- Decisions taken and approvals received: D-011 recorded as Proposed; no owner approval yet
- Critical risks unresolved: R06, R17–R19, R22–R26; R05 and R08 implemented pending acceptance and a deployed check; F-003 open
- Test accounts: four local DeepSpace test accounts now exist (two added for this work, free); the team suites skip themselves if fewer than four are usable
- What the assistant can do next without user input: nothing further in this scope
- What the owner alone must do: accept or amend D-008 to D-011; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-18, about 13:20 US Central (Claude Code, Prompt 009)
- Step IDs completed or blocked: timers, room lifecycle, abuse limits, resilience states and security audit IMPLEMENTED and TESTED locally; not VERIFIED LIVE; none blocked; no stop condition met
- Repo/branch/commit or working-tree revision: `main` at 704d027, uncommitted working tree
- Exact paths changed: see the 13:20 checkpoint in `01_PROGRESS.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vite build` pass; unit: PASS: 7 files, 275 tests, 0 failed (235 existing, 40 new in `hardening.test.ts`); Playwright (direct), full regression: PASS: 60 passed, 4 skipped (the two eight-minute tests and the two restart phases, all opt-in), 0 failed, exit 0 (5.3 min); restart recovery: PASS: phase a 1 passed (21 s), server stopped (port closed), phase b 1 passed (58 s); unattended deadline: PASS: 1 passed, 0 failed, exit 0 (8.4 min): with no action sent for eight minutes, the solo and the team log each held all nine scheduled events at their exact times, the room row read completed, and both results gave the deadline as the reason; the sweep that ran meanwhile reported completed 0, so the timer job did it
- Architecture: D-012 in `03_DECISIONS.md`; gate evidence at the end of `06_ARCHITECTURE_GATES.md`
- SDK facts verified in the installed 0.44.2 source: JobRoom persists jobs and runs them from the Durable Object alarm, and counts every run as an attempt (hence 64 allowed runs for nine scheduled instants plus actions); CronRoom tasks run on `intervalMinutes`; PresenceRoom sends user id and name to every connection, so the route must gate it; `deleteWhere` takes equality filters, 500 rows per call
- Code path (for interview): `startRoom` in `src/actions/index.ts` enqueues `settle-simulation`; `runJob` in `src/jobs.ts` hands it to `runSettleJob` in `src/server/game/timer.ts`, which calls `settleSimulation` in `commands.ts` (the same fold-and-append a sync performs) and asks to run again at the next due instant
- One real tradeoff: the timer is a convenience, not an authority. It only calls idempotent settling, so it cannot double an event, and the game is still correct if it never fires — at the cost of keeping two triggers (job and request) for one piece of logic
- One failure case and its test: the server stops mid-game — after it starts again the next incident appears at its exact time with no request sent (`tests/hardening.spec.ts`, "server restart", run as two invocations with `BLACKOUT_RESTART=a` then `=b`)
- Running the opt-in tests: `BLACKOUT_SLOW=1` for the eight-minute runs; `BLACKOUT_RESTART=a` then `b` within about six minutes for the restart check
- Decisions taken and approvals received: D-012 recorded as Proposed; no owner approval yet
- Critical risks unresolved: R06, R17, R19, R22, R26–R32; R18, R23, R24 addressed pending acceptance; F-003 open; F-006 closed
- Test accounts: five local DeepSpace test accounts now exist (the fifth, "Blk echo", is used only by the limit tests, which exhaust its allowance for up to an hour); `tests/hardening.spec.ts` skips itself if fewer than five are usable
- What the assistant can do next without user input: nothing further in this scope
- What the owner alone must do: accept or amend D-008 to D-012; git add/commit/push; approve any deploy

## Checkpoint record — 2026-11-18, about 15:40 US Central (Claude Code, Prompt 011)
- Step IDs completed or blocked: J, K worked (interface, responsive layout, accessibility basics); N touched (postmortem, history); none blocked
- Repo/branch/commit or working-tree revision: `main` at 17fa068 (pushed in Prompt 010), uncommitted working tree
- Exact paths changed in this pass: see the Prompt 011 checkpoint in `01_PROGRESS.md`
- Commands and tests actually run: `tsc --noEmit` pass; `eslint .` pass; `vitest run` 275/275; `vite build` pass; Playwright `ui.spec` 7/7; `visual` (opt-in) 3/3; full regression: first run (before `ui.spec.ts` existed) 59 passed, 1 failed (F-007, passed 4 of 4 alone), 7 skipped by design; a second run including `ui.spec.ts` was NOT COMPLETED: it was stopped by the Claude Code harness because the machine was low on memory, before it printed any result; it was not restarted. So the new UI spec and the older specs have each passed, but not together in one run. Eight-minute and restart tests not rerun
- URLs/screenshots/logs/evidence refs: `02_EVIDENCE_LOG.md` 15:40 rows; screenshots in `.deepspace/shots/` (git-ignored; regenerate with `BLACKOUT_SHOTS=1 npx playwright test visual ...`)
- SDK versions/API assumptions verified: `deepspace` 0.44.2 unchanged. Only hooks already in use (`useQuery`, `useAuth`, `useAuthProfileReady`, `usePresenceRoom`, `useUsers`, `AuthOverlay`, `signOut`); no new server call
- Decisions taken and approvals received: D-013 proposed, not yet accepted. Added `@fontsource-variable/inter` and `@fontsource-variable/public-sans` (free, self-hosted)
- Stable test hooks: every `data-testid` the earlier specs use is kept. New ones: `landing-*`, `home-*`, `signed-out-panel`, `gate-sign-in`, `history-*`, `copy-code`, `copy-status`, `readiness`, `abandon-confirm`, `abandon-cancel`, `severity`, `clock-label`, `live-announcement`, `action-requires-<id>`, `open-evidence-<seq>`, `evidence-*`, `outcome-summary`, `end-reason`, `score-breakdown`, `score-part-<key>`, `score-total`, `outcome-criteria`, `consequences`, `no-costs`, `run-result`, `run-again`, `back-to-runs`, `back-to-rooms`
- Not built, by design: no generated advice in the postmortem; no replay of a finished run (a new simulation is offered instead); no leaderboard or statistics; no light theme
- Critical risks unresolved: R06, R17, R19, R22, R26–R36; F-003 and F-007 open
- What the assistant can do next without user input: nothing further in this batch
- What the owner alone must do: accept or amend D-008 to D-013; git add/commit/push; approve any deploy

## Prompt 011B — visual redesign (2026-11-18, uncommitted)
- Scope: presentation only. Landing, command center, lobby and setup, evidence record, postmortem, home, history and settings were recomposed as a ruled, monochrome editorial layout. No file under `src/game`, `src/server`, `src/actions` or `worker.ts` changed in 011 or 011B.
- Reference: `design/blackout-reference.png` holds one command-center screen, not several screens; the other screens were designed to match its language.
- Checks actually run: `tsc --noEmit` exit 0; `eslint .` exit 0; `vite build` exit 0; Vitest 274/275 at the default timeout and 275/275 with `--testTimeout=30000` (F-008); Playwright `ui.spec` + `team-ui.spec` 8/8 with one worker; `ui.spec` + `team-ui.spec` + `simulation.spec` + `smoke.spec` 32 passed, 1 failed, 1 skipped with two workers, the failure being a history-row lookup by position in `tests/ui.spec.ts`, since changed to look the run up by its id (`data-run-id`) and passing. `team.spec`, `hardening.spec` and `collab.spec` were not rerun in 011B.
- Screenshots: `.deepspace/shots/`, 19 screens at 1440, 820 and 390 px. Desktop images of the solo run and postmortem predate the last phone-only fixes (status strip stacking below 640 px; landing captions hidden below 1024 px).
- Open: F-003, F-007, F-008. Owner alone: accept or amend D-008 to D-013, review the redesign, commit, push, deploy.

## Checkpoint record — 2026-11-18, about 17:50 US Central (Claude Code, Prompt 012)
- Step IDs completed or blocked: final QA and release-readiness review. Nothing deployed.
- Repo/branch/commit: `main`, HEAD 17fa068 = `origin/main`; Prompts 011, 011B and 012 are uncommitted in the working tree.
- Paths changed in 012: `src/components/game/CommandCenter.tsx`, `src/pages/(app)/(protected)/team.tsx`, `src/pages/index.tsx` (one colour class), `src/styles.css` (one token), `src/game/engine.test.ts` (one per-test timeout), `tests/team.spec.ts` (F-007), `tests/ui.spec.ts`, `tests/visual.spec.ts`, `tests/endings.spec.ts` (new), and flow docs 01, 02, 03, 08, 10, 14, 16.
- Not changed: `src/game/engine.ts`, `src/game/lobby.ts`, everything under `src/server` and `src/actions`, `worker.ts`, schemas, `wrangler.toml`.
- Commands and tests actually run: type-check, lint, build exit 0; Vitest 275 of 275 at default settings; browser batches with one worker: `ui.spec` + `team-ui.spec`: 8 passed; `team.spec`: 13 passed; `team.spec -g "simultaneous, conflicting" --repeat-each=8`: 8 passed; `simulation.spec` + `smoke.spec` + `api.spec` + `collab.spec`: 30 passed, 1 skipped (eight-minute test, opt-in); `hardening.spec`: 16 passed, 3 skipped (eight-minute test and the two restart phases, opt-in); `BLACKOUT_ENDINGS=1 endings.spec`: 1 passed (8.3 min); one complete run: PASS: 70 passed, 0 failed, 5 skipped in 20.8 min (skipped by design: `endings.spec`, run separately above; the two older eight-minute tests; the two restart phases). This is the first complete run of every spec file together, including `ui.spec` and the screenshot tests.
- Not run in 012: the two older eight-minute tests (`BLACKOUT_SLOW=1`) and the two restart phases (`BLACKOUT_RESTART`); their code paths (`timer.ts`, `commands.ts`) are unchanged since they last passed, and `endings.spec` exercised the deadline for three unattended simulations.
- Screenshots: `.deepspace/shots/`, 113 files, 21 screens at 1440, 820, 390 px.
- F-007 and F-008: closed, see `02_EVIDENCE_LOG.md`.
- Decisions: D-014 proposed. D-008 to D-014 await the owner.
- Release assessment: locally ready; the first deploy is the owner's step. Before it: decide the source of record (R02), accept the proposed decisions, commit. After it: deployed smoke test and one three-person room (R37), then a screen-reader and second-browser pass (R33).
- What the assistant can do next without user input: nothing further in this batch.
- What the owner alone must do: the decisions above; `git add`/commit/push; `deepspace deploy`.

## Checkpoint record — 2026-11-18, about 18:40 US Central (Claude Code, Prompt 013)
- Step: release checkpoint. One milestone commit on top of 17fa068 holds Prompts 011, 011B and 012 and this documentation; its SHA is in `git log` and in the Prompt 013 report. Pushed to `origin/main` by explicit instruction. Nothing deployed.
- Decisions: D-008 to D-015 audited in `03_DECISIONS.md` ("Decision audit"); all remain proposed. D-015 records the 011B redesign that D-013 no longer described.
- Checks at the checkpoint: type-check, lint, build exit 0; unit 275 of 275; the complete browser run of 17:50 (70 passed, 0 failed, 5 skipped) still describes this code.
- First deploy, in order, owner only: (1) accept or amend D-008 to D-015 and decide R40; (2) `npx deepspace auth whoami` as the owning account; (3) `npx deepspace status --json` and confirm `sourceInference: github` is what is wanted, because the deploy claims GitHub permanently (R02); (4) `npx deepspace secrets configs create prd` (R41); (5) `npx deepspace deploy` from a clean `main`; (6) confirm `serving: confirmed`, then `npx deepspace releases`, `npx deepspace logs --follow --json`, open `https://blackout.app.space`, run the smoke flow and one three-person room (R37). Never run `deepspace push` before that first deploy.
- Open: F-003; R22, R27, R33, R36 to R41.

## Checkpoint record — 2026-11-18, about 22:00 US Central (Claude Code, Prompt 014)
- Step: first production deployment and verification. Live at https://blackout.app.space. Release 1 `rel_01M7RWT5WBS88YTPJ38XYA68TA` from 297daec; release 2 `rel_01M7RXA54FCJCWB3ENRKE9E610` from a1d5b32 (focus fix F-009). Current production = release 2 = a1d5b32 plus nothing else; later commits on `main` are documentation only.
- Source of record: GitHub `ahuoyizaenesi/blackout`, permanent. Never run `deepspace push`. To release: commit, push, then `npx deepspace deploy` from a clean `main`.
- Decisions D-008 to D-016 accepted by the owner.
- Production tests: `tests/prod.playwright.config.ts` points the specs at the live URL. Run one process at a time; never aim `hardening.spec` "abuse limits", "room lifecycle" or "server restart" at production.
- Not verified in production: abuse limits, lobby expiry/deletion by the sweep, restart recovery, a real account through the hosted sign-in page (R42), screen reader and other browsers (R33).
- The URL has not been shared with anyone and nothing was submitted.

## Checkpoint record — replace after each actual slice
- Checkpoint timestamp/timezone:
- Step IDs completed or blocked:
- Repo/branch/commit or working-tree revision:
- Exact paths changed:
- Claude Code version/model **observed**:
- Commands and tests actually run; pass/fail/skipped:
- URLs/screenshots/logs/evidence refs:
- SDK versions/API assumptions verified:
- Decisions taken and approvals received:
- Critical risks unresolved:
- What ChatGPT can do next without user input:
- What the owner alone must do:

## Recovery rules
1. Re-read `01_PROGRESS.md`, newest `02_EVIDENCE_LOG.md` entries, `03_DECISIONS.md`, risks, and current phase step.
2. Treat this handoff as a pointer; cross-check stale descriptions against actual repository and tool output.
3. If prior Claude output or repository state is missing, ask for the smallest necessary evidence, not a wholesale repeat of history.
4. Never assume a previous chat's tool access, checkout, tokens, or deployment session persist.
5. Before continuing, identify the *first* unsatisfied acceptance criterion; start there.
