# Phase L — Resilience, security and operational correctness

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### L01 — Threat model the app

- [ ] **Execute:** Assets, trust boundaries, attacker abilities and abuse cases.
- **Accept when:** Threat table.
- **Evidence:** _Not yet recorded._

### L02 — Enforce auth server-side

- [ ] **Execute:** Never rely only on frontend gating or role labels.
- **Accept when:** Anonymous mutation rejected.
- **Evidence:** _Not yet recorded._

### L03 — Audit hidden-data leakage

- [ ] **Execute:** Inspect network responses/subscriptions and logs for private flags.
- **Accept when:** No leakage.
- **Evidence:** _Not yet recorded._

### L04 — Rate limit commands

- [ ] **Execute:** Bound per-user/room actions and expensive reads.
- **Accept when:** Flood test passes.
- **Evidence:** _Not yet recorded._

### L05 — Validate input sizes

- [ ] **Execute:** Room codes, names, chat/evidence strings and IDs bounded.
- **Accept when:** Abuse tests pass.
- **Evidence:** _Not yet recorded._

### L06 — Ensure idempotency

- [ ] **Execute:** Retries and duplicate requests cannot double-charge effects.
- **Accept when:** Duplicate test passes.
- **Evidence:** _Not yet recorded._

### L07 — Handle race conditions

- [ ] **Execute:** Simultaneous start/join/role/action/approval/finish.
- **Accept when:** Parallel tests pass.
- **Evidence:** _Not yet recorded._

### L08 — Handle disconnected clients

- [ ] **Execute:** Show offline state; no fabricated success; reconcile on return.
- **Accept when:** Reconnect verified.
- **Evidence:** _Not yet recorded._

### L09 — Handle server restart/hibernation

- [ ] **Execute:** Recompute overdue actions and deadlines from durable timestamps.
- **Accept when:** Recovery verified.
- **Evidence:** _Not yet recorded._

### L10 — Handle storage failures

- [ ] **Execute:** Do not acknowledge commands without durable success.
- **Accept when:** Failure path tested.
- **Evidence:** _Not yet recorded._

### L11 — Handle expired states

- [ ] **Execute:** After deadline, reject late commands and finalize once.
- **Accept when:** Boundary verified.
- **Evidence:** _Not yet recorded._

### L12 — Handle room abandonment

- [ ] **Execute:** Document recovery, expiration and cleanup rules.
- **Accept when:** Cleanup safe.
- **Evidence:** _Not yet recorded._

### L13 — Audit secrets

- [ ] **Execute:** Scan repo, diffs, logs and deployment config for sensitive material.
- **Accept when:** No secrets leaked.
- **Evidence:** _Not yet recorded._

### L14 — Set minimal logging

- [ ] **Execute:** Structured error codes without tokens or private participant data.
- **Accept when:** Operational visibility.
- **Evidence:** _Not yet recorded._

### L15 — Accessibility failure checks

- [ ] **Execute:** No color-only status, focus traps, keyboard, reduced motion.
- **Accept when:** Usability verified.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** M
