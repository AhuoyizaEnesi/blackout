# Phase O — GitHub, DeepSpace deployment and production QA

**Status:** NOT STARTED  
**Entry gate:** Prior phase completed or recorded exception.  
**Exit gate:** All steps closed with evidence; blockers resolved; relevant architectural decisions logged.

### O01 — Review repository and attribution

- [ ] **Execute:** Owner Git identity, commit trailers, branch state and .gitignore.
- **Accept when:** Git audit passes.
- **Evidence:** _Not yet recorded._

### O02 — Confirm source of record before first deploy

- [ ] **Execute:** Inspect DeepSpace status/sourceInference and GitHub remote.
- **Accept when:** GitHub authority confirmed.
- **Evidence:** _Not yet recorded._

### O03 — Create owner-approved checkpoint

- [ ] **Execute:** Commit/push only under owner control.
- **Accept when:** Known-good revision tagged/logged.
- **Evidence:** _Not yet recorded._

### O04 — Check production environment

- [ ] **Execute:** Required secrets/bindings and non-billable settings.
- **Accept when:** Production config ready.
- **Evidence:** _Not yet recorded._

### O05 — Check usage and cost

- [ ] **Execute:** Inspect DeepSpace account quotas and feature costs again.
- **Accept when:** No unapproved spend.
- **Evidence:** _Not yet recorded._

### O06 — Run predeploy checklist

- [ ] **Execute:** Local tests, typecheck, build, privacy and secrets all pass.
- **Accept when:** Release gate passes.
- **Evidence:** _Not yet recorded._

### O07 — Deploy to DeepSpace

- [ ] **Execute:** Use documented CLI deployment to .app.space; capture result.
- **Accept when:** Live URL obtained.
- **Evidence:** _Not yet recorded._

### O08 — Verify actual app URL

- [ ] **Execute:** Open from unauthenticated browser and navigate landing/auth.
- **Accept when:** Live entry works.
- **Evidence:** _Not yet recorded._

### O09 — Verify production solo path

- [ ] **Execute:** Create, play, end, refresh and revisit report.
- **Accept when:** Live solo evidence.
- **Evidence:** _Not yet recorded._

### O10 — Verify production multiplayer

- [ ] **Execute:** Separate user contexts connect and see consistent events.
- **Accept when:** Live multiplayer evidence.
- **Evidence:** _Not yet recorded._

### O11 — Verify production negative paths

- [ ] **Execute:** Unauthorized actions, invalid room, late requests rejected.
- **Accept when:** Live security smoke.
- **Evidence:** _Not yet recorded._

### O12 — Verify no hidden costs

- [ ] **Execute:** Check usage after smoke tests and disable unwanted integration calls.
- **Accept when:** Spend within gate.
- **Evidence:** _Not yet recorded._

### O13 — Capture deploy metadata

- [ ] **Execute:** Repository URL, revision, app URL, test results and deployment timestamp.
- **Accept when:** Release record.
- **Evidence:** _Not yet recorded._

### O14 — Plan revert

- [ ] **Execute:** Document redeploy of known-good revision if critical failure.
- **Accept when:** Rollback procedure.
- **Evidence:** _Not yet recorded._

### O15 — Freeze stable submission version

- [ ] **Execute:** Avoid new untested features near cutoff.
- **Accept when:** Release locked.
- **Evidence:** _Not yet recorded._

## Phase handoff

- **Completed by/date:** _Pending_
- **Tests/evidence links:** _Pending_
- **Open blockers and owner approvals:** _Pending_
- **Next phase:** P
