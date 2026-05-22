# AgentBook Rubric Scorecard — 2026-05-21

**Methodology:** See `docs/superpowers/specs/2026-05-21-gtm-assessment-design.md` §5.
**Evidence base:** `2026-05-21-code-review.md` (382 findings) + `2026-05-21-prior-findings-index.md`.
**Evidence rule:** every score cites a file:line, prior-finding ID, or rubric section. Lack of evidence = 0.

---

## Tier 1 — Agent-Native DNA (target ≥ 32/40)

### #1 Agent-first architecture (12 pts)

| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Every primary workflow can be completed via chat alone | 3 | **1** | Telegram bot covers core flows; web has 22 form-only paths (Stream A.4). Partial only. |
| UI panels are views on agent state, not parallel CRUD | 3 | **0** | A.4: dashboard pages fetch independently; chat-driven changes don't appear live. Receipt dropzones non-functional theater. |
| Multi-step actions show a plan before executing | 2 | **0** | A.4: zero `PlanPreview` component anywhere on web. Telegram has it; web does not. |
| Agent's intermediate state is visible | 2 | **0** | A.4: generic spinners; no "checking your March expenses…" intermediate messaging. |
| No "secret form path" duplicating an agent skill | 2 | **0** | A.4: 22 form-only paths duplicate skills (auto-deduction below). |
| **Subtotal** | **12** | **1** | |
| **Auto-deductions** | | **-1 (capped)** | 22 form-only paths × -2 = -44, capped at category subtotal. |
| **Net** | | **0/12** | |

### #2 Skill-driven intelligence (12 pts)

| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| First-class entities (manifest, version, metadata) | 3 | **3** | `BUILT_IN_SKILLS` array + `AbSkillManifest` model exist. |
| Discoverable from chat | 2 | **1** | `general-question` skill returns help text; no enumerable `/skills` API. |
| Hot-addable without redeploy | 2 | **1** | `POST /agent/seed-skills` upserts at runtime; but skills routing is hardcoded so a new skill still needs code. |
| Measurable (success rate, eval score) | 3 | **0** | A.1: no per-skill metrics; `AbConversation.skillUsed` written but never aggregated. |
| Composition (planner chains skills) | 1 | **1** | `agent-planner.ts` chains multi-step plans. |
| Marketplace / third-party support | 1 | **0** | No third-party skill SDK. |
| **Subtotal** | **12** | **6** | |
| **Auto-deductions** | | **-6** | -4 hardcoded if/else routing (A.1 server.ts:2480 regex chain) -2 no skill metrics |
| **Net** | | **0/12** | |

### #3 Human-in-the-loop quality (10 pts)

| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Confidence-scored escalation | 2 | **0** | A.1: no threshold-based escalation; agent guesses on low confidence. |
| Destructive actions confirm | 2 | **0** | A.1 BLOCKER: `classifyAndExecuteV1` runs destructive ops BEFORE confirm prompt is shown. `confirmBefore: true` flag decorative. |
| Plan preview before multi-step | 2 | **0** | A.4: no web `PlanPreview` component. |
| Corrections persist to memory | 2 | **1** | A.1: `AbUserMemory` write path exists in agent-brain; quality unverified (no test). |
| Undo / rollback | 1 | **0** | A.1 launch: undo's reverse call swallows failures (catch {}); user sees "Undone" even on 500. |
| Audit trail of agent decisions | 1 | **1** | `AbEvent` writes exist on most paths. |
| **Subtotal** | **10** | **2** | |
| **Auto-deductions** | | **-2 (capped)** | -3 destructive without confirm + -2 no plan preview, capped at subtotal |
| **Net** | | **0/10** | |

### #4 Core agent quality (6 pts)

| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Intent accuracy ≥ 92% on canonical set | 2 | **0** | Nightly suite not run (Stream B.8/B.9 deferred from option-c scope). No measurement. |
| Hallucination rate ≤ 2% | 2 | **0** | Not measured. |
| Multi-turn coherence | 1 | **0** | Not measured. G-OLD-018 indicates known issue: only Stage-3 LLM path reads convCtx. |
| Memory recall correctness | 1 | **0** | Not measured. |
| **Subtotal** | **6** | **0** | |
| **Auto-deductions** | | **0** | |
| **Net** | | **0/6** | |

### **Tier 1 total: 0 / 40** 🔴

**Hard floor TRIPPED:** Tier 1 < 32 → overall score capped at **90**.

---

## Tier 2 — Domain Workflows (28 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 5 | Bookkeeping | 8 | **4** | Works (production-readiness 18/20 baseline). Deductions: receipt dropzones theater (A.4), Plaid tokens in-memory Map (A.2), OCR auto-execute bypasses verify framework (A.2). Schema OK (money is `Int` cents). Ledger immutability verified. |
| 6 | Invoicing | 6 | **3** | Core flow works. Deductions: public invoice endpoint enumerable (A.2 blocker), Stripe checkout webhook unsigned (A.2 blocker), no idempotency on `POST /payments` (A.2 blocker), HTML masquerading as PDF (G-OLD-006). |
| 7 | Tax | 6 | **3** | Math solid (Phase 6 regression). Deductions: `effectiveRate` field doesn't exist → NaN% (A.1), CA tax e2e missing (G-OLD-013), no proactive layer, no scenario sim verified. |
| 8 | Budget / advisor | 4 | **2** | Endpoints exist; quality unverified. `monthlyBurnCents` math broken (A.1: count-based proxy). N+1 in client-health. |
| 9 | Consultation Q&A | 4 | **2** | `general-question` exists. No citation framework. "I don't know" honesty unverified. |
| | **Tier 2 total** | **28** | **14** | |

---

## Tier 3 — Activation (14 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 10 | Onboarding & first-15-min | 8 | **2** | A.4 finding: `Onboarding.tsx` is a traditional 7-step wizard (business_type → jurisdiction → currency → bank → telegram) — anti-agent-first. No agent-driven onboarding. Receipt dropzones non-functional. |
| 11 | Billing / monetization | 4 | **2** | Works in canonical webhook handler. Deductions: domain plugins bypass `checkQuota`/`incrementUsage` entirely (A.2 blocker); quota fails open on DB errors; subscribe trusts header tenant. |
| 12 | Plaid / bank sync | 2 | **1** | Endpoints exist; encrypted token storage at route layer. Deductions: in-memory token Map in plugin (A.2 blocker), cross-tenant `findFirst` lookups, naive CSV import, 30-day fixed window (no cursor). |
| | **Tier 3 total** | **14** | **5** | |

---

## Tier 4 — Trust & Ops (15 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 13 | Security & tenant isolation | 5 | **0** | Catastrophic: `resolveAgentbookTenant` accepts unverified header + `'default'` fallback (A.3 blocker); `/switch-tenant` unauthenticated (A.3 blocker); `/admin/llm-configs` no auth + apiKey plaintext (A.1+A.3 blocker); multiple cross-tenant `findFirst({id})`; two Stripe webhooks unsigned; line tables (`AbJournalLine`, `AbExpenseSplit`, `AbInvoiceLine`) have no `tenantId` (A.5 blocker). |
| 14 | Observability & ops | 4 | **1** | `AbEvent` table exists. No Sentry/Datadog/Pino structured logging; LLM cost not tracked; no error tracking dashboard. |
| 15 | Support & feedback loop | 3 | **1** | Feedback route exists (`/api/v1/feedback`). No in-app support widget. Failures often `catch {}` swallowed (A.1, A.2 multiple). |
| 16 | Legal & data rights | 3 | **1** | Auth + roles exist. No `/legal/privacy`, `/legal/terms` paths found; data export/delete endpoints unverified. |
| | **Tier 4 total** | **15** | **3** | |

---

## Tier 5 — Platform Extensibility (3 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 17 | Multi-platform adapter abstraction | 3 | **0** | Adapter refactor (Task B.6) deferred from option-c scope. Telegram-specific code still embedded throughout agent brain and core route. |

---

## Hard Floors

| Cap | Triggered? | Evidence |
|-----|------------|----------|
| Tier 1 < 32 → cap at 90 | **YES** (Tier 1 = 0) | Tier 1 zeroed by auto-deductions |
| No plan preview for multi-step → cap at 85 | **YES** | A.4: no web PlanPreview |
| Skills hardcoded if/else → cap at 85 | **YES** | A.1: regex chain at server.ts:2480 |
| Destructive action without confirm → cap at 85 | **YES** | A.1: classifyAndExecuteV1 ordering bug |
| Corrections never persist → cap at 85 | NO | Memory write path exists in agent-brain |

**Effective cap: 85** (binding cap is 85; Tier 1 floor cap of 90 is non-binding because raw score is already < 85).

---

## Final score

- **Raw sum:** 0 + 14 + 5 + 3 + 0 = **22 / 100**
- **After hard-floor caps:** min(22, 85) = **22 / 100**
- **Distance to 95:** **73 points**
- **Distance to launch-defensible (≥75):** **53 points**
- **Distance to revenue-defensible (≥60):** **38 points**

---

## Top 5 highest-leverage gaps (points reclaimed / effort)

Ordered by leverage. Effort is rough engineer-days assuming senior dev + Claude.

| Rank | Gap | Pts recoverable | Effort | Leverage (pts/day) |
|------|-----|-----------------|--------|--------------------|
| 1 | **Lock down tenant resolution + switch-tenant + admin auth** — fixes 3 of the 6 P0 security blockers. Single shared auth layer change. | +5 (Tier 4 #13) | 2 | 2.5 |
| 2 | **Split `classifyAndExecuteV1` into classify + execute; gate execute on confirm** — fixes the rubric auto-fail clause; unblocks the 85 cap. | +3 (auto-fail cap lift) + +3 (Tier 1 #3) = **+6** | 3 | 2.0 |
| 3 | **Verify Stripe webhook signatures everywhere; delete duplicate unsigned handlers** — closes 2 ship-blockers (A.2 expense+invoice) with one fix pattern. | +3 (Tier 4 #13 + Tier 2 #6) | 1 | 3.0 |
| 4 | **Refactor skill routing to manifest-driven (delete regex chain)** — lifts the second auto-fail cap. | +4 (Tier 1 #2) | 5 | 0.8 |
| 5 | **Build web `PlanPreview` component + integrate** — third auto-fail cap. | +4 (Tier 1 #1+#3) | 3 | 1.3 |

**If we close #1–5: cap lifts from 85, Tier 1 ~20/40, raw total ~50/100.** Still well below 95 but defensible.

---

## What 95 actually requires

Reaching 95+ requires:
1. All 5 leverage gaps above closed
2. All 26 blocker-severity findings closed
3. Tier 1 ≥ 32/40 (requires agent-first refactor of web UI — 22 form-only paths converted to chat-first or marked NOTE-exempt)
4. Stream B test suite (deferred) built and green
5. Stream B.8/B.9 nightly suite running with ≥92% intent accuracy

Realistic estimate to 95+: **6–10 engineer-weeks**, not days. Realistic estimate to "ship to first paying customer safely" (≥75): **3–4 engineer-weeks**.

The 4-week target is **plausible for the safety-to-ship line (75)**; **unrealistic for the 95+ public-launch line** unless scope shrinks dramatically (e.g., launch with web fully chat-driven and a smaller feature surface).
