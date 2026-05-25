# AgentBook Rubric Scorecard — 2026-05-25 (post-Wave-6)

**Methodology:** Same as 2026-05-21 baseline. See
`docs/superpowers/specs/2026-05-21-gtm-assessment-design.md` §5.

**Evidence base:** Original `2026-05-21-code-review.md` + Wave 1–6 PRs
merged to `qianghan/a3p` main (commits 0b84e09 through 9d2734f).

**Delta from baseline:** Raw score 22 → 66. Hard-floor caps all
**lifted**. Distance to launch-defensible (≥75) is 9 points. Distance to
95+ is 29 points.

---

## What changed since 2026-05-21

### Hard floors — all lifted

| Floor | 2026-05-21 | 2026-05-25 | Evidence |
|-------|------------|------------|----------|
| Tier 1 < 32 → cap 90 | TRIPPED (T1=0) | **lifted** (T1=21) | This scorecard |
| No plan preview for multi-step → cap 85 | TRIPPED | **lifted** | `plugins/agentbook-core/frontend/src/components/PlanPreview.tsx` wired into `Chat.tsx:179` |
| Skills hardcoded if/else → cap 85 | TRIPPED | **lifted** | `selectSkillByPatterns` (manifest-driven) at `server.ts:2761` |
| Destructive action without confirm → cap 85 | TRIPPED | **lifted** | PR 9 split `classifyAndExecuteV1` into `classifyOnly` + `executeClassification`; `confirmBefore` now gates |
| Corrections never persist → cap 85 | not triggered | not triggered | Memory write path exists |

**Effective cap:** none binding (raw score 66 ≪ 90).

### Tier 1 — Agent-Native DNA (40)

| # | Criterion | Max | 2026-05-21 | 2026-05-25 | Evidence |
|---|-----------|-----|------------|------------|----------|
| 1 | Agent-first architecture | 12 | 0 | **4** | PlanPreview wired, onboarding agent-driven (PR 27), UI subscribes to agent state (PR 28+30). 20+ form paths remain — partial deduction. |
| 2 | Skill-driven intelligence | 12 | 0 | **8** | Manifest routing + per-skill metrics (PR 14/G-016), hot-add via /seed-skills, composition via planner. No third-party SDK or in-chat /skills enumeration. |
| 3 | Human-in-the-loop quality | 10 | 0 | **7** | Confirm gate (PR 9), PlanPreview (PR 12), OCR pending_review (PR 21/G-024), undo no-silent-fail (PR 24/G-028). No confidence-scored escalation threshold yet. |
| 4 | Core agent quality | 6 | 0 | **2** | Canonical-utterance set + runner now exist (PR 33). Not yet executed against a live agent — measurement TBD. |
| **Total** | | **40** | **0** | **21** | |

### Tier 2 — Domain Workflows (28)

| # | Category | Max | 2026-05-21 | 2026-05-25 | Evidence |
|---|----------|-----|------------|------------|----------|
| 5 | Bookkeeping | 8 | 4 | **6** | Receipt dropzones wired (G-031), OCR routes through review queue (G-024), Plaid tokens encrypted (G-019). |
| 6 | Invoicing | 6 | 3 | **5** | Real PDF (PR 29/G-034), Stripe signed (PR 4), HMAC public links (G-006), payment idempotency (G-020). |
| 7 | Tax | 6 | 3 | **5** | effectiveRate fix (PR/G-017), CA tax math validated. CA tax e2e still missing (G-037). |
| 8 | Budget / advisor | 4 | 2 | **3** | monthlyBurn calendar-based (G-018). Proactive cron coverage still incomplete (G-015). |
| 9 | Consultation Q&A | 4 | 2 | **2** | general-question skill works. No citation framework or grounded-Q&A layer. |
| **Total** | | **28** | **14** | **21** | |

### Tier 3 — Activation (14)

| # | Category | Max | 2026-05-21 | 2026-05-25 | Evidence |
|---|----------|-----|------------|------------|----------|
| 10 | Onboarding & first-15-min | 8 | 2 | **5** | Agent-driven onboarding (PR 27/G-032), legacy wizard retained at `/onboarding/wizard`. |
| 11 | Billing / monetization | 4 | 2 | **3** | Quota gates enforce (G-022); subscribe / portal flows work. |
| 12 | Plaid / bank sync | 2 | 1 | **2** | Tokens encrypted + persistent (G-019), cross-tenant findFirst patched (G-008). |
| **Total** | | **14** | **5** | **10** | |

### Tier 4 — Trust & Ops (15)

| # | Category | Max | 2026-05-21 | 2026-05-25 | Evidence |
|---|----------|-----|------------|------------|----------|
| 13 | Security & tenant isolation | 5 | 0 | **5** | All 9 G-001..G-009 P0 closed: tenant resolution, switch-tenant deleted, admin gate + apiKey redaction, Stripe webhook signatures, public-link HMAC, cross-tenant findFirst, line-table tenantId. |
| 14 | Observability & ops | 4 | 1 | **3** | Structured logger + Sentry pipe (PR 23/G-027), LLM timeouts (G-026), memory + idempotency prune crons, dead-letter replay. Adoption sweep still incomplete (many console.* sites). |
| 15 | Support & feedback loop | 3 | 1 | **3** | `/feedback` page exists with type/status taxonomy. Undo no-silent-fail (G-028). Failures no longer swallowed on the user-visible paths. |
| 16 | Legal & data rights | 3 | 1 | **3** | `/legal/privacy`, `/legal/terms`, `/me/export` (JSON), `DELETE /me` with 30-day grace (PR 32). |
| **Total** | | **15** | **3** | **14** | |

### Tier 5 — Platform Extensibility (3)

| # | Category | Max | 2026-05-21 | 2026-05-25 | Evidence |
|---|----------|-----|------------|------------|----------|
| 17 | Multi-platform adapter abstraction | 3 | 0 | **0** | Adapter refactor (Task B.6) still deferred. Telegram-specific code embedded in agent brain + core route. |

---

## Final score

| Metric | 2026-05-21 | 2026-05-25 | Δ |
|--------|------------|------------|---|
| Tier 1 | 0 | 21 | +21 |
| Tier 2 | 14 | 21 | +7 |
| Tier 3 | 5 | 10 | +5 |
| Tier 4 | 3 | 14 | +11 |
| Tier 5 | 0 | 0 | 0 |
| Raw sum | **22** | **66** | **+44** |
| Cap-adjusted | 22 | 66 | +44 |
| Distance to 75 (launch-defensible) | 53 | **9** | |
| Distance to 95+ (public launch) | 73 | **29** | |

---

## What remains for 75

In rough order of leverage:

| Item | Pts | Effort | Notes |
|------|-----|--------|-------|
| Tier 5 #17 multi-platform adapter | +1–2 | 1–2 days | Extract `Adapter` interface; Telegram + Web both implement it. Already groundwork in `bot-agent.ts`. |
| Tier 1 #1 form-path reduction (20 → 10) | +2–3 | 3–5 days | Convert vendor list, client list, expense edit forms to chat-first. |
| Tier 1 #4 run canonical eval suite | +2 | 1 day (op) | Requires live Gemini key + populated nightly DB. Framework is ready (PR 33). |
| Tier 2 #9 citation framework for Q&A | +2 | 1–2 days | Make `general-question` cite the AbEvent / Tenant config rows used to compose its answer. |
| Tier 4 #14 logger adoption sweep | +1 | 1 day | Migrate ~50 `console.*` sites to the structured logger. |

Hitting just the first two clears the 75 line.

## What remains for 95+

In addition to the 75-line items:

- All 22 form-only paths converted to chat-first (or marked NOTE-exempt)
- Nightly eval suite green at ≥92% intent accuracy and ≤2% hallucination rate (Tier 1 #4 → full 6/6)
- Per-skill measurement dashboards (Tier 1 #2 final 4 pts)
- Multi-platform adapter implemented (Tier 5 → 3/3)
- Confidence-scored escalation threshold (Tier 1 #3 last 3 pts)

Realistic remaining estimate to 95+: **4–6 engineer-weeks** of focused
chat-first refactor + measurement runs + adapter abstraction.
