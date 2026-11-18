# Phase I — DeepSpace multiplayer and server authority

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### I01 — Create room server flow

- [ ] **Execute:** Authenticated owner creates unique simulation record and lobby.
- **Accept when:** Create test passes.
- **Evidence:** _Not yet recorded._

### I02 — Implement secure join

- [ ] **Execute:** Validate room state, capacity, membership, invitation semantics.
- **Accept when:** Join tests pass.
- **Evidence:** _Not yet recorded._

### I03 — Implement role claims

- [ ] **Execute:** Atomic unique role allocation; same identity cannot occupy duplicate slots.
- **Accept when:** Race tests pass.
- **Evidence:** _Not yet recorded._

### I04 — Implement host/start rules

- [ ] **Execute:** Host can start only when lobby criteria satisfied.
- **Accept when:** Start tests pass.
- **Evidence:** _Not yet recorded._

### I05 — Bind role to identity

- [ ] **Execute:** No client-supplied role trust on execution.
- **Accept when:** Forged role rejected.
- **Evidence:** _Not yet recorded._

### I06 — Implement command endpoint

- [ ] **Execute:** Submit idempotent commands with server-side validation.
- **Accept when:** Command tests pass.
- **Evidence:** _Not yet recorded._

### I07 — Implement atomic transitions

- [ ] **Execute:** Serialize state read/validate/effect/write and event receipt.
- **Accept when:** Concurrency tests pass.
- **Evidence:** _Not yet recorded._

### I08 — Implement action approvals

- [ ] **Execute:** Commander reviews precise requests; approval cannot be reused.
- **Accept when:** Approval tests pass.
- **Evidence:** _Not yet recorded._

### I09 — Implement event subscriptions

- [ ] **Execute:** All players receive authoritative updates in sequence.
- **Accept when:** Two-browser test passes.
- **Evidence:** _Not yet recorded._

### I10 — Implement presence

- [ ] **Execute:** Connected/disconnected labels do not change authorization.
- **Accept when:** Presence works.
- **Evidence:** _Not yet recorded._

### I11 — Implement solo mode

- [ ] **Execute:** Unified role controller with auto-recorded approvals.
- **Accept when:** Solo path works.
- **Evidence:** _Not yet recorded._

### I12 — Implement reconnect

- [ ] **Execute:** Resume same identity/role, reconcile action state and clock.
- **Accept when:** Refresh/reconnect test passes.
- **Evidence:** _Not yet recorded._

### I13 — Implement duplicate-tab handling

- [ ] **Execute:** One participant identity across tabs; no duplicate seat or duplicated writes.
- **Accept when:** Two-tab test passes.
- **Evidence:** _Not yet recorded._

### I14 — Implement room isolation

- [ ] **Execute:** Guessed IDs and cross-room access denied.
- **Accept when:** Isolation test passes.
- **Evidence:** _Not yet recorded._

### I15 — Implement safe completion

- [ ] **Execute:** Exactly-once terminal result and immutable completed history.
- **Accept when:** Terminal race test passes.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** J
