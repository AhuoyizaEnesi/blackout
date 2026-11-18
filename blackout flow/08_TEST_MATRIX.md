# Acceptance and testing matrix

**Important:** `NOT RUN` means unverified, not failed and not passed. Every test must record run command, environment, actual output and relevant revision in `02_EVIDENCE_LOG.md`.

| ID | Feature / risk | Test type | Expected result | Phase | Status |
|---|---|---|---|---|---|
| T01 | Pure engine determininism | Unit | Identical input => identical transition | H/M | NOT RUN |
| T02 | Action prerequisites | Unit | Invalid action yields no effects | E/H/M | NOT RUN |
| T03 | Role busy | Unit/integration | Concurrent same-role action rejected | H/I/M | NOT RUN |
| T04 | Timed event ordering | Unit | Fixed ordering at same timestamp | H/M | NOT RUN |
| T05 | Deadline equality | Unit | Exact-deadline completion before ending | H/M | NOT RUN |
| T06 | Four outcomes reachable | Scenario simulation | Reproducible traces each outcome | E/H/M | NOT RUN |
| T07 | Outcome partition exhaustive | Property-based | Every terminal state maps to one ending | E/H/M | NOT RUN |
| T08 | Score | Unit | Exact 0..100 scoring and evidence credit | E/H/M | NOT RUN |
| T09 | Anonymous mutation | Integration | Denied | G/I/L/M | NOT RUN |
| T10 | Forged role | Integration | Denied server-side | G/I/L/M | NOT RUN |
| T11 | Hidden answer leakage | Network/security | Noneligible client sees no private flags | G/L/M | NOT RUN |
| T12 | Create/join/capacity | E2E | Correct lobby and errors | I/J/M | NOT RUN |
| T13 | Simultaneous role claim | Integration | Exactly one claimant succeeds | I/L/M | NOT RUN |
| T14 | Duplicate command | Integration | Effect exactly once | I/L/M | NOT RUN |
| T15 | Conflicting commands | Integration | No lost update or contradictory history | I/L/M | NOT RUN |
| T16 | Commander approval | E2E | Scoped valid approval only | I/J/M | NOT RUN |
| T17 | Two-user synchronization | E2E | Both observe identical committed events | I/M | NOT RUN |
| T18 | Solo golden path | E2E | Complete run/report | J/M/O | NOT RUN |
| T19 | Reconnect and refresh | E2E | State/role/timer recovered | I/L/M | NOT RUN |
| T20 | Duplicate tab | E2E | No duplicate participant or action | I/M | NOT RUN |
| T21 | Long offline/hydration | Integration | Overdue events processed once | L/M | NOT RUN |
| T22 | AI unavailable | Unit/E2E | Template report still renders | K/M | NOT RUN |
| T23 | Responsive + keyboard | Browser/manual | No critical clipping; visible focus | J/N | NOT RUN |
| T24 | Reduced motion | Browser/manual | Animations respect preference | N | NOT RUN |
| T25 | Production room flow | Live smoke | Create/join/action/report works on app.space | O | NOT RUN |
| T26 | Production authorization | Live smoke | Invalid/unauthorized attempts denied | O | NOT RUN |
| T27 | Secrets/attribution/source | Manual audit | Repo safe, owner author, correct source | O | NOT RUN |
