# Claude Code execution and evidence review protocol

**Purpose:** Ensure Claude is an implementation agent, not an unverified authority. Exact task prompts are deliberately out of scope until build start.

## Pre-execution contract
- Establish objective, relevant phase IDs, current code baseline, scope of allowed changes, and measurable acceptance criteria.
- Require code inspection and a plan before impactful modifications; small tasks can follow preapproved patterns.
- Verify model name/version from **actual CLI**; never assume a marketing/model claim from a past discussion.
- Do not transmit secrets into prompts or commit history. Disallow agent Git commits/pushes unless separately authorized.
- Check action for spending implications and new dependencies before running.

## Mandatory Claude output evidence
1. Files added/edited/deleted with purpose; unexpected changes explicitly flagged.
2. User-visible behavior and relevant code path (entrypoint → server validation → persistence → sync).
3. Real commands executed; environment, exit statuses and key output; skipped/unavailable tests acknowledged.
4. Tests written or updated, with what each test establishes; failure tests included.
5. Known issues, assumptions, security risks, follow-up work and proposed next step.
6. Git diff summary and detection of unwanted contributor/co-author metadata (no Git mutation by agent).
7. Manual/browser verification instructions for observable behavior.

## ChatGPT independent review
- Compare diff against task scope and architecture; inspect new/removed dependencies and package scripts.
- Verify auth, room membership, hidden-state isolation, role gates, idempotency, deadlines, data integrity.
- Look for stale mock data, no-op buttons, fabricated backend handlers, silent catch blocks, hard-coded secrets, tests that only assert snapshots or implementation details.
- Re-run or review captured tests where possible; if inaccessible, mark results **agent-reported, not independently verified**.
- Demand proof for multiplayer: separate sessions, conflict sequence, reconnect and state consistency; a screenshot of one browser is insufficient.
- Require deployed smoke test before `VERIFIED LIVE`.

## Failure loop
Record failing command → reproduce → hypothesis → minimal change → focused retest → regression test → log result. Limit speculative patches; revert or escalate after repeated failed hypotheses. Do not modify tests merely to make failures disappear.

## Stage gate
A feature cannot advance from IMPLEMENTED to TESTED or VERIFIED LIVE based solely on Claude saying “done.” Missing evidence remains an explicit gap.
