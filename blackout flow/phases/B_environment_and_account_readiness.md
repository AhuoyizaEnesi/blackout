# Phase B — Environment and account readiness

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### B01 — Inspect workstation

- [ ] **Execute:** Confirm OS, terminal, workspace location and filesystem permissions.
- **Accept when:** Working local directory.
- **Evidence:** _Not yet recorded._

### B02 — Check Node and package manager

- [ ] **Execute:** Verify installed versions against current DeepSpace scaffold requirements.
- **Accept when:** Versions recorded.
- **Evidence:** _Not yet recorded._

### B03 — Check Git and GitHub CLI

- [ ] **Execute:** Verify Git and optional gh availability.
- **Accept when:** Version and auth notes.
- **Evidence:** _Not yet recorded._

### B04 — Check Claude Code CLI

- [ ] **Execute:** Run version/doctor and confirm successful login without exposing tokens.
- **Accept when:** CLI usable.
- **Evidence:** _Not yet recorded._

### B05 — Identify strongest available model

- [ ] **Execute:** Inspect /model rather than assuming prior model names or entitlements.
- **Accept when:** Selected model and fallback recorded.
- **Evidence:** _Not yet recorded._

### B06 — Check model access and quota

- [ ] **Execute:** Verify available usage, limits, plan vs API billing.
- **Accept when:** No surprise API charges.
- **Evidence:** _Not yet recorded._

### B07 — Check DeepSpace login

- [ ] **Execute:** Verify npx deepspace auth whoami; sign in as owner if required.
- **Accept when:** Correct account recorded.
- **Evidence:** _Not yet recorded._

### B08 — Check DeepSpace quotas

- [ ] **Execute:** Inspect usage and paid integration settings before calls.
- **Accept when:** Cost limit understood.
- **Evidence:** _Not yet recorded._

### B09 — Confirm GitHub connection

- [ ] **Execute:** Verify repo access in owner account and optionally from ChatGPT connector.
- **Accept when:** Access test completed.
- **Evidence:** _Not yet recorded._

### B10 — Record Vercel as optional

- [ ] **Execute:** Do not make Vercel part of required deployment.
- **Accept when:** DeepSpace remains target.
- **Evidence:** _Not yet recorded._

### B11 — Create local workspace

- [ ] **Execute:** Create dedicated BLACKOUT project directory separate from this planning folder.
- **Accept when:** Clean workspace.
- **Evidence:** _Not yet recorded._

### B12 — Configure .gitignore

- [ ] **Execute:** Exclude .env, .dev.vars, credentials, sessions and build outputs.
- **Accept when:** Secret exclusions verified.
- **Evidence:** _Not yet recorded._

### B13 — Configure Git author

- [ ] **Execute:** Set owner’s verified name/email; audit attribution and trailers.
- **Accept when:** Commit attribution controlled.
- **Evidence:** _Not yet recorded._

### B14 — Install only needed tools

- [ ] **Execute:** Add DeepSpace agent skill / Playwright / Vitest only if scaffold does not already provide equivalents.
- **Accept when:** Dependencies justified.
- **Evidence:** _Not yet recorded._

### B15 — Capture baseline setup

- [ ] **Execute:** Record versions, startup commands and known environment blockers.
- **Accept when:** Repeatable setup notes.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** C
