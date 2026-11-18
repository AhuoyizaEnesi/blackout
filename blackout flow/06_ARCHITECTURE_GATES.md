# Architecture and SDK verification gates

**Do not copy hypothetical examples into code as though verified.** Read the actual generated scaffold and current SDK references.

## Expected responsibilities

- **React/TypeScript:** visual controls, derived countdown, subscribed read state, pending UI; never authoritative score or hidden flags.
- **DeepSpace authentication:** actual authenticated identity, server re-verification at join and command boundaries.
- **DeepSpace room/server execution:** serialized command path (specific class/API TBD by scaffold), participation and role permissions, deadline processing.
- **Storage:** durable state snapshot + append-only incident events + idempotent command receipts.
- **Realtime/presence:** shared state broadcasts and ephemeral connected indicators; presence is not membership authorization.
- **Pure scenario engine:** validate/apply actions, advance time, calculate outcomes independent of network and UI.

## Build gates

1. Verify DO/room mapping, single-writer/transaction semantics **in the chosen SDK implementation**; serialized single writes alone do not guarantee atomic multi-write transitions.
2. Define read access for private clues; avoid shipping secret flags in client queries.
3. Define the complete server response contract for accepted/rejected commands.
4. Establish idempotency and recovery across restart, refresh, duplicate tabs and retry.
5. Verify timer/alarm capability in the available SDK; always reconcile elapsed timestamps as backup.
6. Decide data retention and orphaned lobby cleanup; do not accidentally delete completed reports.
7. Protect backend routes and WebSocket room reads, not only the frontend page.
8. Configure GitHub source authority *before* first DeepSpace source-producing action.
9. Confirm deployment artifact and source version are auditable.

## Candidate runtime entities (names subject to scaffold)

`Simulation`, `Participant`, `SimulationState`, `IncidentEvent`, `ActionExecution`, `AuthorizationRequest`, `CommandReceipt`, `Postmortem`.

## Non-negotiables

A command is considered successful in UI only after durable server acknowledgement; all game effects can be reconstructed or checked from the saved timeline; expired commands cannot change completed games; room A cannot read room B; owner can explain a complete request trace.
