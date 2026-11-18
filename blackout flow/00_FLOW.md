# BLACKOUT FLOW — Master index

**Purpose:** One source of truth for planning, building, validating, deploying, submitting, and explaining BLACKOUT. This folder is a **plan**, not a completed project or evidence that any step has already passed. No Claude implementation prompts are included.

**Deadline:** Sunday, November 22, 2026 at 11:59 PM Eastern (10:59 PM Central). **Hosting:** DeepSpace `.app.space`. **Repository:** GitHub under the owner's identity. **Cost target:** $0 incremental spend; verify quotas before billable activity. **Deployment:** DeepSpace, not Vercel by default.

## Assistant-first navigation

**For ChatGPT:** Execute `13_ASSISTANT_OPERATOR_PROTOCOL.md` first, recover state from `14_SESSION_HANDOFF.md`, check `16_TRACEABILITY_AND_COVERAGE.md`, and consult `15_CLAUDE_OUTPUT_REVIEW.md` whenever Claude Code reports work. Apply `17_RELEASE_AND_DECISION_GATES.md` at milestones. Only request owner intervention at approval or access boundaries. The owner does **not** need to manually manage 240 steps.

## Reading and execution rules

1. Read `00_FLOW.md`, then `01_PROGRESS.md` and the current phase. All phase steps are numbered `A01`–`P16` and must be executed sequentially **within their phase**, with explicit gates for moving between phases.
2. Update `01_PROGRESS.md` after each task; record proof, blockers, and relevant files in `02_EVIDENCE_LOG.md`.
3. If a prerequisite fails, mark `BLOCKED` and fix it before advancing. Never mark an unrun test `PASS`.
4. Never silently delete a step or overwrite a decision. Revisions require an entry in `03_DECISIONS.md` and relevant references.
5. The owner approves scope/design changes, paid services, source control mutations and production deployment. Claude Code may inspect/edit/run tests under defined approvals but must not commit/push without authorization.
6. Keep user-facing updates short: current step, result, blocker, and any decision needed from owner. Long technical reasoning belongs in these files.
7. For interview claims, cite actual source files, test logs, screenshots and deployed behavior rather than planned architecture.

## Phase directory

| Phase | Scope | Steps | Gate |
|---|---|---:|---|
| [A](phases/A_project_control_and_working_agreement.md) | Project control and working agreement | 14 | Phase A evidence + review |
| [B](phases/B_environment_and_account_readiness.md) | Environment and account readiness | 15 | Phase B evidence + review |
| [C](phases/C_deepspace_sdk_and_repository_discovery.md) | DeepSpace SDK and repository discovery | 14 | Phase C evidence + review |
| [D](phases/D_product_scope_and_user_journeys.md) | Product scope and user journeys | 14 | Phase D evidence + review |
| [E](phases/E_scenario_specification_and_balancing.md) | Scenario specification and balancing | 19 | Phase E evidence + review |
| [F](phases/F_design_system_and_screen_specifications.md) | Design system and screen specifications | 17 | Phase F evidence + review |
| [G](phases/G_architecture_identity_and_data_contract.md) | Architecture, identity and data contract | 16 | Phase G evidence + review |
| [H](phases/H_deterministic_engine_and_logic_tests.md) | Deterministic engine and logic tests | 16 | Phase H evidence + review |
| [I](phases/I_deepspace_multiplayer_and_server_authority.md) | DeepSpace multiplayer and server authority | 15 | Phase I evidence + review |
| [J](phases/J_ui_implementation_in_vertical_slices.md) | UI implementation in vertical slices | 16 | Phase J evidence + review |
| [K](phases/K_postmortem_generation_and_integrations.md) | Postmortem generation and integrations | 10 | Phase K evidence + review |
| [L](phases/L_resilience_security_and_operational_correctness.md) | Resilience, security and operational correctness | 15 | Phase L evidence + review |
| [M](phases/M_automated_testing_and_scenario_proof.md) | Automated testing and scenario proof | 16 | Phase M evidence + review |
| [N](phases/N_accessibility_design_qa_and_performance.md) | Accessibility, design QA and performance | 12 | Phase N evidence + review |
| [O](phases/O_github_deepspace_deployment_and_production_qa.md) | GitHub, DeepSpace deployment and production QA | 15 | Phase O evidence + review |
| [P](phases/P_submission_interview_readiness_and_handoff.md) | Submission, interview readiness and handoff | 16 | Phase P evidence + review |

**Suggested execution dependencies:** A → B → C → D → E → F → G → H → I → J → K → L → M → N → O → P. Testing is continuous: each implementation slice must run its associated tests immediately rather than waiting until Phase M. The phase sequence is an audit/checkpoint order, not a ban on earlier tests or UI prototyping.

## Mandatory hold points

- **Before source initialization/first deploy:** verify GitHub as intended source of record (DeepSpace source claim can be permanent).
- **Before production deployment:** owner approval, verified attribution, zero unintended secrets, local test evidence, and cost check.
- **Before paid integrations:** explicit owner approval, quota/pricing review and a free fallback.
- **Before final portal submission:** deployed app tested independently, all required URLs checked, writeup factual.

## Canonical supporting files

- `04_PRODUCT_BASELINE.md`: product scope and user journeys.
- `05_SCENARIO_BASELINE.md`: scenario facts and known balancing questions.
- `06_ARCHITECTURE_GATES.md`: design invariants and SDK uncertainties.
- `07_DESIGN_BRIEF.md`: visual direction derived from user references.
- `08_TEST_MATRIX.md`: verification map by feature/risk.
- `09_COST_AND_SERVICES.md`: tool choice and zero-spend controls.
- `10_RISKS_AND_OPEN_QUESTIONS.md`: unresolved items with stop conditions.
- `11_SUBMISSION_AND_INTERVIEW.md`: final submission and explanation requirements.
- `12_SOURCES.md`: official reference links to re-check during execution.

**Status legend:** `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `IMPLEMENTED`, `TESTED`, `VERIFIED LIVE`, `DONE`, `SKIPPED (approved with reason)`. A phase is only complete after its acceptance gate and evidence are recorded.

## Assistant-only operations layer

- [13 Assistant operator protocol](13_ASSISTANT_OPERATOR_PROTOCOL.md) — next-step selection, action authority, truthful status and brief owner updates.
- [14 Session handoff](14_SESSION_HANDOFF.md) — resume point and evidence references.
- [15 Claude output review](15_CLAUDE_OUTPUT_REVIEW.md) — implementation evidence and independent review criteria.
- [16 Requirement traceability](16_TRACEABILITY_AND_COVERAGE.md) — ensure no behavior or test requirement disappears.
- [17 Release gates](17_RELEASE_AND_DECISION_GATES.md) — owner approvals and ship/no-ship criteria.
