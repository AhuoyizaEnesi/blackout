# Phase G — Architecture, identity and data contract

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### G01 — Draw actual request flow

- [ ] **Execute:** Browser -> DeepSpace auth/transport -> room/action -> engine -> storage -> subscriptions.
- **Accept when:** Architecture diagram.
- **Evidence:** _Not yet recorded._

### G02 — Set one room per simulation

- [ ] **Execute:** Verify isolation implementation with SDK bindings.
- **Accept when:** Room ID strategy.
- **Evidence:** _Not yet recorded._

### G03 — Define state machine

- [ ] **Execute:** Lobby/active/resolving/completed/abandoned transitions.
- **Accept when:** Allowed transitions.
- **Evidence:** _Not yet recorded._

### G04 — Define record types

- [ ] **Execute:** Simulation, participant, state, action, event, receipt, approval, postmortem.
- **Accept when:** Schema draft.
- **Evidence:** _Not yet recorded._

### G05 — Define stable identifiers

- [ ] **Execute:** App room ID, participant ID, command ID, event seq, request ID.
- **Accept when:** ID contract.
- **Evidence:** _Not yet recorded._

### G06 — Define authoritative state

- [ ] **Execute:** Clients cannot write metrics or private flags directly.
- **Accept when:** Write boundary.
- **Evidence:** _Not yet recorded._

### G07 — Define access matrix

- [ ] **Execute:** Reads/writes by authenticated actor and in-game role.
- **Accept when:** Access matrix.
- **Evidence:** _Not yet recorded._

### G08 — Define secret separation

- [ ] **Execute:** Private flags and answer keys never sent in public subscriptions.
- **Accept when:** Exposure check.
- **Evidence:** _Not yet recorded._

### G09 — Define persistence model

- [ ] **Execute:** Current snapshot and append-only event history with durable receipts.
- **Accept when:** Data model rationale.
- **Evidence:** _Not yet recorded._

### G10 — Define concurrency boundary

- [ ] **Execute:** Atomic processing or compare-and-swap around validation+effects+event write.
- **Accept when:** Race-safe algorithm.
- **Evidence:** _Not yet recorded._

### G11 — Define approval contract

- [ ] **Execute:** Approval scoped to exact request, action and eligible roles.
- **Accept when:** Approval lifecycle.
- **Evidence:** _Not yet recorded._

### G12 — Define time source

- [ ] **Execute:** Server authoritative deadlines, clock order and overdue reconciliation.
- **Accept when:** Time semantics.
- **Evidence:** _Not yet recorded._

### G13 — Define validation schemas

- [ ] **Execute:** Validate all inputs, room membership, action IDs and sizes.
- **Accept when:** Runtime validation.
- **Evidence:** _Not yet recorded._

### G14 — Define error codes

- [ ] **Execute:** UNAUTHORIZED, INVALID_ROLE, ROOM_FULL, CONFLICT, ROLE_BUSY, EXPIRED and more.
- **Accept when:** Error contract.
- **Evidence:** _Not yet recorded._

### G15 — Define retention and privacy

- [ ] **Execute:** Minimal PII, no real secrets/logs, documented deletion and retention strategy.
- **Accept when:** Privacy plan.
- **Evidence:** _Not yet recorded._

### G16 — Record tradeoffs

- [ ] **Execute:** Why DeepSpace-native, deterministic engine, event+snapshot, no paid AI requirement.
- **Accept when:** ADRs written.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** H
