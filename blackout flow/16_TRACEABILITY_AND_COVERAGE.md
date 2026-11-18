# Requirements-to-evidence traceability

**Purpose:** Prevent steps, user requirements, and failure cases from disappearing in a long implementation. Before each release gate, map every critical requirement to code + test + observed behavior.

| Requirement ID | Source / decision | Implementation path | Automated test | Manual/live evidence | Status |
|---|---|---|---|---|---|
| REQ-01 | Create and join secure room | TBD | TBD | TBD | PLANNED |
| REQ-02 | Role uniqueness and server-only authorization | TBD | TBD | TBD | PLANNED |
| REQ-03 | Deterministic incident state machine | TBD | TBD | TBD | PLANNED |
| REQ-04 | Four reachable exclusive endings | TBD | TBD | TBD | PLANNED |
| REQ-05 | Time events, server clock and deadline tie-breaking | TBD | TBD | TBD | PLANNED |
| REQ-06 | Atomic/conflict-safe idempotent commands | TBD | TBD | TBD | PLANNED |
| REQ-07 | Role-private clues never leaked to other clients | TBD | TBD | TBD | PLANNED |
| REQ-08 | Reconnect and recovery after client inactivity | TBD | TBD | TBD | PLANNED |
| REQ-09 | Solo mode and 3-player collaboration | TBD | TBD | TBD | PLANNED |
| REQ-10 | Persistent audit history and truthful postmortem | TBD | TBD | TBD | PLANNED |
| REQ-11 | Editorial, restrained responsive UI and accessibility | TBD | TBD | TBD | PLANNED |
| REQ-12 | DeepSpace-native architecture and correct .app.space deploy | TBD | TBD | TBD | PLANNED |
| REQ-13 | Zero unapproved spend, protected secrets, owned Git commits | TBD | TBD | TBD | PLANNED |
| REQ-14 | Submission URLs and transparent agent disclosure | TBD | TBD | TBD | PLANNED |

## Coverage loop
- When a requirement is added, create an ID before code work; link to phase step and decision record.
- When a feature lands, fill source path and actual test path, not placeholder success.
- On any major modification, inspect impacted requirements and rerun their tests.
- For a cut or deferral, mark `DEFERRED` with approval, rationale and writeup implication.
- At release gate, any unverified critical requirement is a blocker or an explicitly disclosed limitation.
