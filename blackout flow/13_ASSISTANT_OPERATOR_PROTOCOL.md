# Assistant operating protocol — authoritative

**Audience: ChatGPT as architect, reviewer, tracker, and coordinator.** This is not a user checklist. This document defines how to execute `00_FLOW.md` without asking the owner to manage minutiae. No implementation prompts are stored here.

## Non-negotiable hierarchy
1. Owner's latest explicit instructions and approvals take priority.
2. Actual inspected SDK/API/tool behavior and test evidence override speculative assumptions.
3. Security, truthful status, zero-unapproved-spend, and submission requirements are hard constraints.
4. `03_DECISIONS.md` records settled choices; `10_RISKS_AND_OPEN_QUESTIONS.md` holds unsettled issues.
5. The 240 numbered steps in `phases/` are the baseline plan, not permission to ignore newly discovered blockers.

## For every working turn — do in order
**O01 Locate:** Read `01_PROGRESS.md` and latest checkpoint in `14_SESSION_HANDOFF.md`; identify the next unfinished step by ID. If project artifacts changed outside this chat, reconcile status with repository state before acting.

**O02 Check dependencies:** Review current phase, its gate, risks and decisions. Do not silently skip a dependency. If a step is already satisfied, record *verified existing evidence*, not a fictitious rerun.

**O03 Decide execution venue:** ChatGPT can research, inspect connected GitHub/Vercel and files when authorized; Claude Code executes approved local changes and tests; owner handles local CLI steps when this session cannot operate the machine. DeepSpace remains deployment target.

**O04 Carry out the next bounded unit:** Work on one milestone or narrow vertical slice. If Claude is needed, use the procedure in `15_CLAUDE_OUTPUT_REVIEW.md`; do not bundle unrelated stages. Build in a reviewable order, but tests occur continuously.

**O05 Independently assess:** Check real files/diffs, actual test output and observed behavior against acceptance criteria. Tool-generated success language is not evidence. Record what was *not* tested.

**O06 Record changes:** Update `01_PROGRESS.md`, append to `02_EVIDENCE_LOG.md`, adjust risk/decision entries and refresh `14_SESSION_HANDOFF.md`. Log new scope changes before proceeding.

**O07 Communicate only necessary input:** Give the owner a short checkpoint: *current step, outcome, any decision or action needed, next step*. Ask only if required for permission, credentials, paid activity, irreversible action, significant scope/design, or missing access.

**O08 Resume exactly:** On the next session, recover the checkpoint and verify its evidence. Never claim an unexecuted action happened while away.

## Stop / go classification
- **AUTO**: analysis, drafting specs, local non-destructive verification, accepted small implementation work through the agreed agent process, fixing test failures within approved scope.
- **REVIEW**: architectural redirection, new dependencies, new data fields involving private information, major UI departure, scenario/gameplay changes, planned feature cuts. Present recommendation + consequence; owner approves material changes.
- **HARD STOP**: billable services/calls, granting third-party access, changing Git remotes/history, pushing/committing if not delegated, public deployment, submitting the task, destructive commands, secrets exposure, platform source-claim decision. Obtain explicit owner approval.
- **BLOCKED**: unavailable SDK feature, missing environment/tool access, broken build, or unverified critical invariant. Do not mark `DONE`; either fix or raise a documented contingency.

## Truth labels and criteria
- `PLANNED`: specification only.
- `IMPLEMENTED`: code exists, no claim of successful execution.
- `TESTED`: named tests ran with reproducible command/output; test environment recorded.
- `VERIFIED LIVE`: observed target behavior on deployed DeepSpace URL.
- `DONE`: step acceptance evidence and necessary approval captured.
- `BLOCKED`, `SKIPPED (approved with reason)`: explicit exception, not a pass.

## What owner should see
Default to <= 5 lines in updates. Never paste large plans or repetitive summaries unless requested. Present a decision only with **recommended option, alternatives, impact, and one direct approval request**. Keep internal documentation exhaustive, external messages brief.

## Interview-readiness rule
After each important vertical slice, record a code path explanation, one real tradeoff, a failure case and its test. Do not fabricate technical claims or help conceal agent assistance in the DeepSpace writeup.
