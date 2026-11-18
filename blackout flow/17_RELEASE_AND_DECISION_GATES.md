# Release gates and owner approval boundaries

## Minimal owner interventions
**Require owner action/approval** for: permissions/credentials; Git identity and source/remotes; adding external providers; new spending or billing; material product/design/scope changes; public deployment; final submission. Handle technical minutiae internally.

## Gate 0 — Before modifying source
- Actual local/connected repo inspected; Node/DeepSpace/Claude versions observed, not assumed.
- DeepSpace official docs and generated scaffold checked; no imagined APIs.
- Feature acceptance criteria and test approach documented.
- Confirm owner Git attribution policy and no agent commits.

## Gate 1 — First playable local path
- Create/join → launch → single valid action → persisted state → timeline works.
- Unauthorized action denied server-side, not just hidden in UI.
- Local build/tests pass with recorded evidence.
- UI is not a borrowed reference layout; design is reviewed on actual screen.

## Gate 2 — Complete simulation
- All action prereqs/effects/durations and timed events tested.
- All four mutually exclusive endings reachable, gold path feasible in 8 minutes.
- Solo and multiplayer work; conflicts/retries/reconnect verified.
- Postmortem grounded in actual event history; offline fallback works.

## Gate 3 — Preproduction
- Security/privacy and secrets review, accessibility/responsive checks.
- Build, typecheck, unit/integration/multi-client tests with real logs.
- Cost/quota and source-of-record claim checked.
- Owner expressly approves public deployment.

## Gate 4 — Deployment and submission
- Deployed `.app.space` URL and GitHub URL independently opened and tested.
- Live smoke test from fresh session; one simultaneous multiplayer test.
- GitHub author metadata inspected; AI usage disclosed honestly.
- Clear writeup covering DeepSpace integrations, main tradeoff, agent contributions, owner's verification.
- Owner approves portal submission; retain evidence and recovery notes.

## Deadline contingency
Never overpromise full scope. If a gate is not achievable in time, explicitly choose a smaller **working** scope, log the tradeoff and limitations, verify it end to end, and ensure owner approval. Keep the DeepSpace requirement and submission deadline non-negotiable.
