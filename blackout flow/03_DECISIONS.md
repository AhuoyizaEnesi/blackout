# Decision register / architecture decision records

No product or technical decision is silently overwritten. New decisions get stable IDs. Any rejected proposal stays visible with reasons.

| ID | Date | Decision | Rationale / tradeoff | Owner status | Affected steps |
|---|---|---|---|---|---|
| D-001 | 2026-11-17 | DeepSpace-native auth, persistence, realtime and deployment are default. | Exercise specifically evaluates SDK understanding; minimize added services. | Agreed | C,G,I,O |
| D-002 | 2026-11-17 | GitHub is intended source of record and owner owns commits. | Submission demands repo; contributor attribution under owner control. | Agreed, verify before first deploy | A,B,C,O |
| D-003 | 2026-11-17 | Deterministic incident engine, optional AI narration only. | Testability, cost, safety and coherent outcomes. | Proposed baseline | E,H,K |
| D-004 | 2026-11-17 | Clean, editorial, professional interface; no generic AI dashboard. | User references and design instructions. | Agreed | F,J,N |
| D-005 | 2026-11-17 | No additional paid service without owner approval. | $0 target. | Agreed | A,B,K,O |
| D-006 | 2026-11-17 | Claude Code edits and tests; owner controls Git/deploy. | Auditability and interview ownership. | Agreed | A,M,O,P |

| D-007 | 2026-11-17 | This flow is ChatGPT's operating manual, not an owner-managed checklist. | Assistant maintains progress, evidence, handoffs and gates; owner only handles approvals and access. | Explicit owner instruction | All |

## New decision template

**ID/date:**  
**Problem and options:**  
**Decision:**  
**Why / consequences:**  
**Owner approval:**  
**Files and steps affected:**  
**Verification / follow-up:**
