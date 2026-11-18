# Product baseline — BLACKOUT

**Product:** An interactive, fictional crisis-response simulation in which a solo player or a team acts under time pressure with incomplete information and consequences. Not an operational cybersecurity tool.

## MVP (subject to product acceptance steps D/E)

- Eight-minute scenario: Operation Nightfall at fictional Meridian Cloud.
- Solo playable; cooperative mode with up to three participants (Commander, Security Engineer, Infrastructure Engineer).
- Create/join room, lobby, role choice, server-authoritative start.
- Event feed, private findings with explicit sharing, role-restricted actions and approvals.
- Durable action progress and timer, multiple endings, auditable timeline and postmortem.
- Stable refresh/reconnect behavior; authorization and race safety; clean responsive UI.

## Reviewer's golden path

1. Visit deployed URL; understand the premise without instruction.
2. Sign in only if required by verified auth design; start solo or create invite room.
3. Start; inspect first alert; investigate and share evidence (if team).
4. Request/approve major intervention; observe server-confirmed event/metric changes.
5. Finish or hit deadline; inspect traceable report and score.
6. Refresh and retrieve the same completed run.

## Out of scope by default

- Real security system access; voice/video; payments; email invitations; multiple scenario packs; external databases; autonomous AI changing results; elaborate analytics, paid AI dependency.

## Acceptance principles

- Polished complete flow > many disconnected features.
- Native DeepSpace capabilities where suitable; no invented SDK endpoints.
- Critical actions require server authorization; only real tested behavior appears in submission.
- Explicitly mark product requirements that are still unsettled in `10_RISKS_AND_OPEN_QUESTIONS.md`.
