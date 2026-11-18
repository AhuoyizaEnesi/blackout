# Phase M — Automated testing and scenario proof

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### M01 — Establish baseline

- [ ] **Execute:** Record scaffold tests and test runner config.
- **Accept when:** Baseline evidence.
- **Evidence:** _Not yet recorded._

### M02 — Unit tests for reducer

- [ ] **Execute:** Validate deterministic effects, no-op replays and metric bounds.
- **Accept when:** Unit suite green.
- **Evidence:** _Not yet recorded._

### M03 — Unit tests for time

- [ ] **Execute:** Minute boundaries, tie order, exact deadline, long hibernation.
- **Accept when:** Clock suite green.
- **Evidence:** _Not yet recorded._

### M04 — Unit tests for endings

- [ ] **Execute:** Four endings plus priority and impossible combinations.
- **Accept when:** Outcome proof saved.
- **Evidence:** _Not yet recorded._

### M05 — Unit tests for scoring

- [ ] **Execute:** Exact arithmetic and non-negative bound.
- **Accept when:** Score suite green.
- **Evidence:** _Not yet recorded._

### M06 — Integration auth tests

- [ ] **Execute:** Anonymous, expired and wrong-role requests are denied.
- **Accept when:** Auth suite green.
- **Evidence:** _Not yet recorded._

### M07 — Integration persistence tests

- [ ] **Execute:** Action receipt and timeline survive reload.
- **Accept when:** Persistence suite green.
- **Evidence:** _Not yet recorded._

### M08 — Integration concurrency tests

- [ ] **Execute:** Two conflicting commands, duplicate requests, parallel room joins.
- **Accept when:** Race suite green.
- **Evidence:** _Not yet recorded._

### M09 — E2E single-player

- [ ] **Execute:** Start-to-finish solo run within controlled test clock.
- **Accept when:** Solo test green.
- **Evidence:** _Not yet recorded._

### M10 — E2E multiplayer

- [ ] **Execute:** Three clients, distinct roles, real-time subscriptions and approval.
- **Accept when:** Multiplayer test green.
- **Evidence:** _Not yet recorded._

### M11 — E2E reconnect

- [ ] **Execute:** Reload/offline/online and duplicate tabs.
- **Accept when:** Reconnect test green.
- **Evidence:** _Not yet recorded._

### M12 — E2E unhappy paths

- [ ] **Execute:** Invalid/full room, busy roles, forbidden command, expired incident.
- **Accept when:** Failure suite green.
- **Evidence:** _Not yet recorded._

### M13 — Visual/layout tests

- [ ] **Execute:** Desktop/mobile, overflow, dialogs, reduced motion, keyboard.
- **Accept when:** UI suite green.
- **Evidence:** _Not yet recorded._

### M14 — Run all local checks

- [ ] **Execute:** Typecheck, lint, build and full relevant test suite.
- **Accept when:** CI-equivalent pass.
- **Evidence:** _Not yet recorded._

### M15 — Log flaky tests

- [ ] **Execute:** No silent retries; root-cause flaky synchronization.
- **Accept when:** Flake log cleared.
- **Evidence:** _Not yet recorded._

### M16 — Independent review

- [ ] **Execute:** Read diffs and manually verify a representative critical flow.
- **Accept when:** Owner confirmation.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** N
