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

## Gate evidence — multiplayer (D-011), 2026-11-18

Checked against the installed deepspace 0.44.2 source and then on the local worker and Durable Object (`tests/team.spec.ts`, `tests/team-ui.spec.ts`); not yet on a deployed app.

- **Single-writer semantics:** lobby and simulation logs both take one insert per `(id, seq)`; concurrent joins, role claims, starts, approvals and actions from several accounts each produced exactly one event per position.
- **Private clue read access / protect WebSocket reads:** a raw realtime connection subscribed to every game collection received the room's rows only when its user was listed on them; a participant never received another participant's private finding; a non-member received nothing.
- **Presence is not membership authorization:** presence is used for display only; every permission comes from the lobby log.
- **Room A cannot read room B:** two started rooms sharing two people — commands, approvals and realtime rows stayed within each room.
- **RecordRoom does not provide game roles:** it provides collection permissions and per-row owner/collaborator reads; game roles are enforced in server actions.

## Gate evidence — timers, lifecycle and abuse protection (D-012), 2026-11-18

Checked against the installed deepspace 0.44.2 source and then on the local worker and Durable Objects (`tests/hardening.spec.ts`); not yet on a deployed app.

- **Server time is the only time:** start, deadline, action start and completion are stamped by the server; times sent in a request are ignored; direct socket writes to the simulation row and its events are denied.
- **Unattended finalization without a second source of truth:** a JobRoom job calls the same idempotent settling code as a sync. With no request sent, incidents appeared once at their exact instants, the deadline was finalized, and a restart did not lose or repeat anything.
- **Cleanup cannot destroy history:** deletion requires a lobby log that is closed, never started, with no simulation events, and 7 days old; a started room swept ten years ahead was still complete and readable by its three members only.
- **Presence is not membership authorization, and is no longer public:** the presence route itself now requires membership; membership is still decided only by the lobby log.
- **Scheduler and queue are not player-reachable:** both sockets refuse non-admins before reaching the Durable Object; the queue takes no socket writes at all.

