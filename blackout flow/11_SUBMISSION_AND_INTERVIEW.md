# Submission and interview readiness

## Portal deliverables

1. **Live DeepSpace URL** (`https://<app>.app.space`), tested in fresh browser.
2. **GitHub repository URL** with reviewable, owner-controlled commits and setup instructions.
3. **Short writeup** explaining product, actual DeepSpace integrations used, principal tradeoff, what Claude Code did, what owner personally verified, and remaining limitations.
4. **On-time submission** before Sunday November 22, 2026, 11:59 PM Eastern.

## Honest evidence requirements

- Do not claim a model, integration, deployed behavior, test pass, or performance metric without direct verification.
- Do not obscure Claude's role; sole Git commit author is different from sole code writer.
- If a feature is not finished, say what would be done next and why it was cut.
- Avoid confidential employer/school/client data; all incident material remains fictional.

## Interview topics to prepare from actual code

- Walk through create room -> authenticate -> role assign -> start -> execute command -> persist -> broadcast -> report.
- Explain why the simulation engine is deterministic and what AI could safely add.
- Explain consistency/serialization/atomicity, idempotency and conflicting concurrent actions.
- Explain timer boundary cases, server restarts, reconnect and duplicate tabs.
- Explain data separation, room authorization, private evidence and rate limiting.
- Explain DeepSpace-specific primitives used and why external systems were omitted.
- Explain test strategy and show a reproducible failure or test evidence.
- Practice making a small change, running the relevant test, debugging and explaining tradeoffs.

## Final gate

Owner checks deployed URL, repository, test ledger, screenshot, budget, model attribution wording and the submitted form before pressing submit.
