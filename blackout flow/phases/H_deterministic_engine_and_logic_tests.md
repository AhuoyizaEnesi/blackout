# Phase H — Deterministic engine and logic tests

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### H01 — Define engine types

- [ ] **Execute:** State, action, event, effect, transition, score and outcome.
- **Accept when:** Types compile.
- **Evidence:** _Not yet recorded._

### H02 — Implement pure transition function

- [ ] **Execute:** No network calls, random model output or browser clock inside reducer.
- **Accept when:** Pure function tested.
- **Evidence:** _Not yet recorded._

### H03 — Implement action validation

- [ ] **Execute:** Role, phase, prerequisites, one-time use and approval checks.
- **Accept when:** Invalid commands rejected.
- **Evidence:** _Not yet recorded._

### H04 — Implement pending actions

- [ ] **Execute:** One operation per role; start, end, status and cancellation policy.
- **Accept when:** Durations correct.
- **Evidence:** _Not yet recorded._

### H05 — Implement deterministic scheduler

- [ ] **Execute:** Advance clock across pending completions and timed events.
- **Accept when:** Ordered transitions.
- **Evidence:** _Not yet recorded._

### H06 — Implement tie-breaking

- [ ] **Execute:** Timed events before action completions at same timestamp; terminal evaluation last.
- **Accept when:** Boundary tests pass.
- **Evidence:** _Not yet recorded._

### H07 — Implement metric clamps

- [ ] **Execute:** Clamp all numerical state to 0..100.
- **Accept when:** Boundary tests pass.
- **Evidence:** _Not yet recorded._

### H08 — Implement private evidence

- [ ] **Execute:** Evidence discovery sets correct flags without public leakage.
- **Accept when:** Visibility tests pass.
- **Evidence:** _Not yet recorded._

### H09 — Implement one-time effects

- [ ] **Execute:** Repeat action/event cannot grant extra score or metrics.
- **Accept when:** No farming.
- **Evidence:** _Not yet recorded._

### H10 — Implement conditional event rules

- [ ] **Execute:** Trigger only when predicates true, once per event key.
- **Accept when:** Scenario tests pass.
- **Evidence:** _Not yet recorded._

### H11 — Implement containment semantics

- [ ] **Execute:** Both session revocation and key rotation required.
- **Accept when:** Threat tests pass.
- **Evidence:** _Not yet recorded._

### H12 — Implement outcomes

- [ ] **Execute:** Four ordered and mutually exclusive outcomes.
- **Accept when:** Ending tests pass.
- **Evidence:** _Not yet recorded._

### H13 — Implement score calculation

- [ ] **Execute:** Exact 100-point model; snapshot proof.
- **Accept when:** Score tests pass.
- **Evidence:** _Not yet recorded._

### H14 — Run property tests

- [ ] **Execute:** No negative values, impossible phase transitions or nondeterminism.
- **Accept when:** Property suite passes.
- **Evidence:** _Not yet recorded._

### H15 — Prove scenario routes

- [ ] **Execute:** Complete recovery, costly recovery, partial containment, escalation.
- **Accept when:** Four evidence traces saved.
- **Evidence:** _Not yet recorded._

### H16 — Review engine for interview

- [ ] **Execute:** Owner can explain transition rules and why AI does not choose results.
- **Accept when:** Technical checkpoint.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** I
