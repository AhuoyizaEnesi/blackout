# Zero-additional-spend tooling policy

## Required baseline

- **DeepSpace CLI/SDK:** backend/auth/storage/realtime/hosting, use native primitives where possible.
- **Claude Code CLI:** implementation and test execution on owner's workstation; confirm actual account model and quota in CLI.
- **Node.js, Git, GitHub:** local build and repository provenance.
- **DeepSpace native testing / Playwright; Vitest if needed:** only add packages if scaffold lacks equivalent facilities.
- **ChatGPT:** planning, independent review, interview preparation, not a substitute for local test execution.

## Optional only if justified

- Claude Desktop for local workflow/visual review.
- Vercel connected but **not** deployment target for this exercise.
- Paid AI report polishing only with explicit approval and verified credits; deterministic report is default.

## Explicitly excluded unless approved

Supabase, Firebase, Redis, Sentry paid plans, external email, LiveKit, separate servers, domain purchases, paid stock imagery, paid hosting, unbounded AI calls.

## Cost checks

1. Confirm Claude Code plan/model rather than assume unlimited free CLI access.
2. Inspect DeepSpace account usage, source/deploy entitlement and integration prices.
3. Avoid integration calls until guardrails, rate limiting and credentials are known.
4. Capture usage before/after the production smoke test.
5. If any core function would incur a charge, **stop and ask owner** rather than silently paying.
