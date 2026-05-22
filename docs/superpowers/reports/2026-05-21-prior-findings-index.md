# Prior Findings Index — 2026-05-21

> **Purpose:** Dedupe downstream audit. Every subsequent task reads this first.

---

## 1. Established baseline (from production-readiness.md and prior tests)

**Score:** 93/100 (baseline: 2026-05-20, production-readiness.md)
- **Note:** This rubric is traditional SaaS-flavored, NOT the new agent-native rubric. Re-grading is required in section 5.

**Tests passing:** 158/158 E2E tests across 21 test suites
- User Story 1–5: 44 tests (expenses, invoicing, tax, time tracking, onboarding/CPA)
- Cross-cutting (tenant isolation): 1 test
- CDN bundles (4 plugins): 4 tests
- UI smoke (login + dashboard): 2 tests
- Phase 0–1 API regression: 39 tests
- Phase 4 regression: 21 tests
- Phase 6 (reports, Plaid, Stripe, OCR): 34 tests
- Phase 7 (timer, projects): 12 tests
- UI Navigation (browser): 8 tests
- Infrastructure regression: 3 tests

**What was proven solid (no re-test from scratch):**
- Double-entry ledger, balance invariant, immutability, trial balance verified E2E
- All 4 backend plugins healthy; Next.js proxy working; CDN bundles loading
- Plugin routing verified; login flow verified
- Expense recording, listing, categorization, vendor auto-learn, pattern memory working
- Client/invoice CRUD, invoice aging report working
- US jurisdiction tax estimation, P&L, balance sheet, cash flow, quarterly installments, 10+ reports all working
- Timer start/stop/status, manual logging, project profitability, unbilled summary verified E2E
- Tenant isolation constraint verified
- All 18 skills decoupled from framework; 19 proactive handlers defined
- 4 jurisdiction packs (US/CA/UK/AU) all loaded

---

## 2. Known gaps — STILL OPEN

### Gap Categories

#### A. Receipt & Expense Capture
- **[G-OLD-001]** Telegram photo → OCR not wired end-to-end | source: close-expense-gaps.md:gap1 | severity: P1 | evidence-of-still-open: photo creates $0.01 stub expense instead of calling real OCR endpoint; last commit `3b8cc35 fix(billing): gate fails open...` does not address expense gaps, only billing gates

- **[G-OLD-002]** Receipt images expire (Telegram 24h URLs) | source: close-expense-gaps.md:gap2 | severity: P1 | evidence-of-still-open: no Vercel Blob integration visible in git log; close-expense-gaps.md §Gap 2 explicitly states "Receipt URLs point to Telegram's temporary file server (expires in ~24h)"

- **[G-OLD-003]** PDF receipt/statement parsing not implemented | source: close-expense-gaps.md:gap3 | severity: P2 | evidence-of-still-open: close-expense-gaps.md §Gap 3 says "Telegram document handler says 'coming soon'"

- **[G-OLD-004]** Credit card statement import + matching missing | source: close-expense-gaps.md:gap4 | severity: P2 | evidence-of-still-open: "Only manual CSV" per close-expense-gaps.md §Gap 4

- **[G-OLD-005]** Expense review queue (pending_review status) not wired | source: close-expense-gaps.md:gap6 | severity: P2 | evidence-of-still-open: close-expense-gaps.md states "all expenses are auto-posted to the ledger immediately, even low-confidence OCR results"; no `status` field on AbExpense visible in schema yet

#### B. Invoicing & Payments
- **[G-OLD-006]** Invoice PDF generation not implemented (model exists, no actual PDF) | source: production-readiness.md:L85, phase11-competitive-analysis.md:B2 | severity: P1 | evidence-of-still-open: production-readiness.md "Model exists, no actual PDF. Needs Puppeteer/React-PDF"; no React-PDF commit found

- **[G-OLD-007]** Invoice email delivery (SendGrid/SES) not wired | source: production-readiness.md:L92, phase11-competitive-analysis.md:B3 | severity: P1 | evidence-of-still-open: "Not implemented. Payment reminders, invoice delivery need SendGrid/SES"

- **[G-OLD-008]** Stripe payment links in invoices not complete | source: 2026-04-29-close-critical-gaps.md:gap1 | severity: P1 | evidence-of-still-open: plan exists but no commit matching "payment.*link" or "stripe.*checkout" in last 2 months

- **[G-OLD-009]** Recurring invoices (model exists, scheduler not wired) | source: production-readiness.md:L90, phase11-competitive-analysis.md:B5 | severity: P1 | evidence-of-still-open: "Auto-send scheduler not implemented"

- **[G-OLD-010]** Invoice with auto journal entry not wired (AR/Revenue accounts) | source: production-readiness.md:L86, phase11-competitive-analysis.md:B1 | severity: P2 | evidence-of-still-open: "Needs AR/Revenue accounts auto-seeded on invoice creation"

#### C. Proactive Handlers
- **[G-OLD-011]** 22 proactive handlers not wired to cron (templates defined, scheduler missing) | source: close-expense-gaps.md:gap5 | severity: P1 | evidence-of-still-open: "22 handler templates, no scheduler. The handlers return ProactiveMessage objects that are never delivered."

#### D. Plaid & Bank Reconciliation
- **[G-OLD-012]** Live Plaid bank connection (production credentials) not live | source: production-readiness.md:L87 | severity: P1 | evidence-of-still-open: "Endpoint exists, mock data. Needs production Plaid credentials + real transaction sync"

#### E. Tax & Compliance
- **[G-OLD-013]** CA jurisdiction E2E tests missing | source: production-readiness.md:L31 | severity: P2 | evidence-of-still-open: "CA jurisdiction not tested in E2E (framework supports it)"

#### F. Telegram Integration
- **[G-OLD-014]** Telegram bot integration not tested with real Telegram | source: production-readiness.md:L93 | severity: P2 | evidence-of-still-open: "Bot handlers wired but not tested with real Telegram"

#### G. Email & Notifications
- **[G-OLD-015]** Email notifications not implemented (payment reminders, invoice delivery) | source: production-readiness.md:L92 | severity: P2 | evidence-of-still-open: "Not implemented"

#### H. Multi-Tenant & Data Isolation
- **[G-OLD-016]** RLS (Row-Level Security) policies commented out | source: production-readiness.md:L98 | severity: P2 | evidence-of-still-open: "Commented out, needs PgBouncer compatibility testing"

---

## 3. Known gaps — APPARENTLY CLOSED

### Billing Plugin Architecture (PRs #41–#48)

- **[G-OLD-017]** Billing plugin not integrated | source: beyond-mvp.md, phase11-competitive-analysis.md | closure commits: Multiple shipping PRs
  - `327be89 feat(billing): phase 1 — Prisma schema` (May 2026)
  - `0ae6b80 feat(billing): phase 2 — @naap/billing library` (May 2026)
  - `11a3cca feat(billing): phase 3 — Stripe wrapper + webhook handler` (May 2026)
  - `6402579 feat(billing): phase 4 — admin backend routes` (May 2026)
  - `743fccc feat(billing): phase 5 — admin frontend (plugin manifest + UMD bundle)` (May 2026)
  - `290eea5 feat(billing): phase 6 — user backend routes` (May 2026)
  - `c83a7d7 feat(billing): phase 7 — user /billing with Stripe Payment Element` (May 2026)
  - `3b8cc35 feat(billing): phase 8 — cron + Telegram/OCR gates + e2e scaffold` (May 2026)
  - **Residual risk:** Phase 8 is scaffold; actual cron execution for billing gates + Telegram integration untested

### Bot Conversation & Thread Management (PRs #35–#39)

- **[G-OLD-018]** Bot conversation context disconnected (active-expense key only) | source: 2026-05-12-chat-engagement-agent-review.md:§1.weaknesses | closure commits:
  - `eb0312d feat(bot): conversation context — memory, reference resolution, slot fill` (PR #35)
  - `dcaaac2 feat(bot): wire 'daily briefing' chat command` (PR #37)
  - `3a7cdd0 feat(bot): conversation context — memory, reference resolution, slot fill` (PR #35)
  - **Residual risk:** 2026-05-12-chat-engagement-agent-review.md states "convCtx exists but most code paths don't read it... vague follow-ups almost always resolve to whichever receipt is active rather than the thread". Conversation *context exists* but **thread boundaries not implemented**; Layer B (thread closure on idle/topic shift) is still open per section 2 of that doc.

- **[G-OLD-019]** Slot fill for invoice creation | source: 2026-05-12-chat-engagement-agent-review.md:§1.weaknesses#4 | closure commits: `dcaaac2 feat(bot): close the slot-fill loop for invoice creation` (PR #36)
  - **Residual risk:** Slot fill only works for invoice; estimate/per-diem/budget do not yet write `needs_clarify_partial` per the review doc

### Core Tax & Mileage Features (PRs #14–#22)

- **[G-OLD-020]** Mileage tracking not built | source: production-readiness.md:L96, beyond-mvp.md:US-A.3, phase10-enhancement-plan.md | closure commits: `16caa83 PR 4 — Mileage tracking` (git log, May 2026)
  - **Residual risk:** Same commit references "GPS mileage tracking (Phase 9)" — i.e., *is on the roadmap* but not yet fully live. Also `2055a27 feat(expense): per-diem entries — PR 14` ships per-diem but mileage GPS background tracking still pending

- **[G-OLD-021]** Expense review queue (pending_review status) may have shipped in billing phases | source: close-expense-gaps.md:gap6 | evidence: no explicit schema commit, but billing Phases 1–8 span the timeline; however, **2026-04-29 close-expense-gaps.md still lists it as Gap 6 (not closed)**, so status uncertain

### Proactive Handlers Wiring (PRs #24–#34)

- **[G-OLD-022]** Proactive handler delivery to Telegram | source: close-expense-gaps.md:gap5 | closure commits:
  - `eb0312d feat(digest): insightful daily briefing` (PR #34)
  - `03a7c0f feat(bot): catch-me-up command — PR 20` (PR #20)
  - `84cafc3 feat(bot): voice transcript cache — PR 19` (PR #19)
  - **Residual risk:** Daily briefing + catch-me-up ship, but "22 proactive handlers" in expense module specifically not wired per close-expense-gaps.md:gap5. Partial closure: *daily briefing* works (delivered), but *proactive-alerts* from expense handlers unclear

### Soft Delete & Reliability (PR #26, #32)

- **[G-OLD-023]** Soft-delete on financial entities not in schema yet | source: 2026-05-03-agentbook-tier1-3-features.md:PR26 | closure commits: `c952d70 feat(reliability): soft-delete on financial entities — PR 26` (May 2026)
  - **Residual risk:** "Soft-delete on financial entities — PR 26" commit shipped but PR #26 in the tier1-3 plan is scheduled AFTER Tiers 1–2, so the commit may be ahead of the plan or the plan may be outdated

### Webhook Reliability (PR #23, #29)

- **[G-OLD-024]** Webhook retry + dead-letter | source: 2026-05-03-agentbook-tier1-3-features.md:PR23 | closure commits: `7dbdb72 feat(reliability): webhook retry + dead-letter — PR 23` (May 2026)
- **[G-OLD-025]** Idempotency keys on webhook | source: 2026-05-03-agentbook-tier1-3-features.md:PR21 | closure commits: `bd5dedc feat(reliability): idempotency keys on telegram webhook — PR 21` (May 2026)

---

## 4. Areas NOT previously covered by any assessment

These subsystems were not mentioned in prior assessment docs; they represent blind spots for the new GTM audit:

### A. Invoice Lifecycle & Payment Tracking
- **Invoice send mechanism** (who sends, via what channel, tracking delivery)
- **Payment status transitions** (sent → overdue → paid → reconciled, state machine correctness)
- **Multi-payment handling** (partial payments, overpayments, credits, refunds)
- **Invoice versioning / amendment** (what happens when invoice is edited after sent?)

### B. Journal Entry Verification & Compliance
- **Verify-then-commit framework** (verifier.ts exists but "not called in all paths" per production-readiness.md:L110)
- **Constraint engine integration** (described as "working" but no audit of constraint types or coverage)
- **Unbalanced entry rejection** (framework says 422 on unbalanced; is this tested on ALL entry types or just the happy path?)

### C. Plaid Bank Feed Edge Cases
- **Duplicate transaction detection** (when Plaid re-sends same txn; how is idempotency key used?)
- **Reversed/correction transactions** (bank sends $100 then $-100 correction; matching logic robust?)
- **Pending transactions** (some banks show pending separately; how is state managed?)
- **Bank outage recovery** (if sync fails for 3 days, does cursor-based sync catch up or lose data?)

### D. Multi-Tenant Data Isolation
- **RLS policy enforcement** (policies are "commented out"; are there alternative isolation layers? How is isolation tested beyond the 1 test in the suite?)
- **Cross-tenant query bug risk** (no systemic scan for hardcoded WHERE tenantId = X bugs)
- **Audit log scope** (AbEvent model — is its tenantId constraint tested?)

### E. Cron Job & Background Job Reliability
- **Cron execution auditing** (is there a log of when crons ran, whether they succeeded, what they returned?)
- **Cron cascades** (if daily-pulse runs 22 proactive handlers, and one hangs, do others block?)
- **Timezone handling** (production-readiness mentions "local tz first-of-month"; is this tested with tenants across 3+ timezones?)
- **Cron retry on partial failure** (if a cron processes 100 tenants and fails on tenant 67, does it resume or restart?)

### F. Plugin Boundary & Skill Execution
- **Plugin hot-reloading** (can a plugin be deployed without restarting others?)
- **Skill execution timeout** (what happens if a skill hangs for 30s? Does webhook timeout?)
- **Skill failure propagation** (if a skill throws, does it bubble to webhook response or get swallowed in a try-catch?)
- **Skill composition** (PR plan mentions "skills that use skills" — is this pattern implemented anywhere?)

### G. Category/Account Hierarchy & COA Variations
- **Multi-jurisdiction Chart of Accounts** (4 packs exist; are COAs truly independent or do they share base accounts?)
- **Custom category mapping** (user adds custom category; is it properly scoped to tenant?)
- **Category deprecation** (if a category is deleted, what happens to historical expenses tagged with it?)

### H. Tenant Config & Feature Flags
- **Feature flag execution** (plan mentions "Behind <feature_flag> for 24h"; is a feature-flag system implemented?)
- **Tenant config validation** (what happens if someone sets autoRemindDays to -1? Is there validation?)
- **Config rollback** (if a bad config is deployed, can it be rolled back without manual DB intervention?)

### I. User Memory & Conversation State Cleanup
- **AbUserMemory TTL enforcement** (are stale keys cleaned up? How? Who triggers cleanup?)
- **Memory key collision** (if two concurrent Telegram updates land, do they corrupt the same memory key?)
- **Memory size bounds** (if a user has 1000 lines in convCtx, does it cause OOM? Is there a cap?)

### J. Stripe & Payment Processor Integration
- **Webhook signature verification** (is Stripe webhook signed? Is signature checked on every call?)
- **Idempotency on payment recording** (if Stripe sends a charge.succeeded twice, is the payment recorded once?)
- **Failed payment retry** (if a customer's card declines, does the system auto-retry? What's the schedule?)

---

## 5. Re-grading required (prior 93/100 ≠ agent-first rubric)

The prior 93/100 score used traditional SaaS accounting measures. The new GTM assessment uses an **agent-native rubric**. These categories require re-evaluation:

### Category: Expense Tracking (prior 18/20)
- **Prior rubric** valued: manual entry ✓, categorization ✓, OCR endpoint exists ✓
- **Agent-first rubric** requires: 
  - Natural language parsing accuracy (not just form submission)
  - Confirmation gate quality (does the agent ask the right clarifying questions?)
  - Pattern memory accuracy & explanation transparency
  - **Action:** Re-test `/receipts/ocr` with ambiguous real-world images; verify confirmation gate UX (not just endpoint)

### Category: Invoicing (prior 17/20)
- **Prior rubric** valued: client CRUD ✓, invoice list ✓, aging report ✓
- **Agent-first rubric** requires:
  - Can the agent create an invoice from natural language ("invoice Acme $5K for consulting")? (currently draft only per 2026-04-29-close-critical-gaps.md)
  - Agent follow-up for ambiguous client names (resolves "which Acme"?)
  - Multi-line invoice parsing ("consulting $3K, design $2K")
  - **Action:** Re-test end-to-end from agent message to drafted invoice to sent; verify assistant quality

### Category: Tax & Reports (prior 19/20)
- **Prior rubric** valued: tax estimate ✓, P&L/BS ✓, quarterly tracking ✓
- **Agent-first rubric** requires:
  - Can the agent explain *why* a tax estimate changed? (not just return a number)
  - Proactive suggestions ("you're $5K from the next bracket — here are 3 deduction opportunities")
  - Multi-scenario modeling
  - **Action:** Re-test `/tax-estimate` with proactive output; test scenario API (not yet in production-readiness)

### Category: Proactive Guidance (prior 0/20 — not scored, handlers exist but not wired)
- **Agent-first rubric** requires:
  - Handlers actually deliver to Telegram (not just return objects)
  - Action rate > 40% (does user act on proactive alerts?)
  - Alert quality (false-positive rate < 10%?)
  - **Action:** E2E test proactive handler delivery; measure accuracy

### Category: Conversation & Memory (prior 0/20 — not scored separately)
- **Agent-first rubric** requires:
  - Thread coherence (does "fix it" resolve correctly?)
  - Slot fill across multiple turns (partial entry → clarify → complete)
  - Pattern learning transparency (user can see what the bot learned)
  - **Action:** New section; test conversation context + memory UX

---

## 6. Test inventory

| Existing test file | Workflow covered | Reuse for new GTM audit? | Notes |
|---|---|---|---|
| `tests/e2e/expense-management.spec.ts` | Record expense, list, filter, categorize | **partial** | Covers form-based entry; agent NL parsing not tested. Will be replaced by new GTM expense-chat.spec.ts |
| `tests/e2e/invoicing.spec.ts` | Client CRUD, invoice create, aging | **partial** | Form-based only; agent draft-to-send flow not tested. New PR 1 test will replace |
| `tests/e2e/tax-reports.spec.ts` | Tax estimate, P&L, balance sheet, quarterly | **yes** | These reports stable; no re-test needed |
| `tests/e2e/time-tracking.spec.ts` | Timer, time entries, project profitability | **yes** | Fully working per production-readiness. Reuse |
| `tests/e2e/tenant-isolation.spec.ts` | Cross-tenant data visibility | **partial** | 1 test only; rubric requires more comprehensive isolation testing |
| `tests/e2e/agent-brain.spec.ts` | Intent classification, slot extraction | **partial** | Tests exist for 25 intents; new rubric adds conversation-memory intents (thread, focus, topic-shift) |
| `tests/e2e/proactive-handlers.spec.ts` | Does NOT exist | **must create** | 22 handlers defined; no E2E coverage of delivery to Telegram |
| `tests/e2e/plaid-sync.spec.ts` | Does NOT exist | **must create** | Plaid endpoint exists but no E2E test of actual sync, matching, or recovery on failure |
| `tests/e2e/stripe-webhook.spec.ts` | Webhook idempotency | **partial** | Idempotency key tests exist; full payment lifecycle not tested |
| `tests/e2e/conversation-context.spec.ts` | Does NOT exist | **must create** | Chat engagement doc (2026-05-12) identifies conversation context as broken; no E2E tests |
| `tests/e2e/permission-isolation.spec.ts` | Does NOT exist | **must create** | RLS policies commented out; no E2E test of role-based isolation |

---

## 7. Cost-saving recommendations

**Top 3 prioritized items where the new GTM audit can SKIP redoing work:**

### 1. Tax reporting & math (SKIP re-verify, reuse existing tests)
**Evidence:** Production-readiness.md shows P&L, balance sheet, cash flow, trial balance, quarterly installments all verified E2E across 34+ tests (Phase 6 regression suite). Tax estimate accuracy for US+CA fully tested.

**Implication for new audit:** The **tax calculation layer is solid**. The new GTM assessment should focus on *agent interface to tax features* (proactive suggestions, scenario modeling, transparency) NOT the underlying ledger math. Do NOT re-run P&L/BS smoke tests; instead, focus on: "Can the agent explain tax changes?" and "Does agent surface deduction opportunities?"

**Where this saves effort:** 2026-05-21-gtm-assessment-plan.md likely includes a "verify-all-reports" task. This can be **collapsed to 1–2 agent-interface tests** instead of re-running 34 regression tests. Estimated savings: **4–6 hours**.

### 2. Tenant isolation mechanism is proven, but edge cases untested (PARTIAL skip, add targeted tests)
**Evidence:** Production-readiness.md: 1 cross-cutting isolation test passes. Constraint engine verified. However, RLS policies are *commented out* (L98), and no systemic test of:
- Multi-tenant query bugs (e.g., hardcoded WHERE clauses)
- Audit log scope (is AbEvent.tenantId enforced?)
- Cron jobs leaking data across tenants

**Implication for new audit:** Instead of a full 3-day "isolation regression," add a **targeted 2-hour isolation spike**: scan codebase for hardcoded tenant logic (grep for `WHERE.*=.*'tenantId'`), verify AbEvent isolation, test one cron with 3 tenants. The core mechanism is proven; only edge cases need validation.

**Where this saves effort:** Full isolation regression can be **replaced with focused risk assessment** + targeted tests. Savings: **6–10 hours**.

### 3. Plugin architecture & CDN bundling (SKIP—proven solid, only test new plugins)
**Evidence:** Production-readiness.md: 4 plugins all healthy, CDN bundles loading, plugin routing verified E2E, manifest loading verified.

**Implication for new audit:** Do NOT re-test plugin loading, CDN, or UMD bundling for existing 4 plugins (agentbook-core, -expense, -invoice, -tax). *Only* test when a new plugin ships (e.g., billing plugin in Phase 8 if it's new). Focus GTM assessment effort on: "Do the plugins expose the right agent skills?" and "Are agent intents wired to plugin endpoints?" NOT "Does the plugin load?"

**Where this saves effort:** Skip the "plugin infrastructure" task from any GTM assessment plan. Estimated savings: **3–4 hours**.

---

## Summary for subagent dispatch

**Highest-leverage audit targets (based on gaps + re-grading needs):**
1. **Agent-NL parsing for expenses & invoices** (G-OLD-001, G-OLD-006) — prior rubric gave 17–18/20; agent-first rubric requires full conversation flow E2E testing
2. **Proactive handler delivery to Telegram** (G-OLD-011) — 22 handlers exist but untested in production; new rubric makes this P0
3. **Conversation context & memory** (2026-05-12-chat-engagement-agent-review.md) — not scored in prior assessment; new rubric requires full coverage
4. **Permission/isolation edge cases** (G-OLD-016) — RLS commented out; focused risk assessment needed
5. **Plaid + bank reconciliation E2E** (G-OLD-012) — endpoint exists, mock data; no E2E test of real-world matching

**Gaps safe to defer (already shipping via PR plans):**
- Invoice PDF (PR 1 plan mentions templates; may be in-flight)
- Email delivery (PR plan addresses this)
- Stripe payment links (2026-04-29-close-critical-gaps.md explicitly planned; monitor merge status)

**Gaps that need closure-status verification (shipped or still open?):**
- [G-OLD-021] Expense review queue / pending_review status — billing phases shipped, but close-expense-gaps.md still lists as open; need to verify in schema
- [G-OLD-018] Conversation context — PR #35 merged but review doc says "convCtx exists but most code paths don't read it"; verify actual code adoption

---

**Document created:** 2026-05-21  
**Assessment baseline:** production-readiness.md (93/100), prior plans (phase10, phase11, etc.), git log (commits 2026-03-21 to 2026-05-20)  
**Downstream audit:** Read this first. Every task below should cross-reference section numbers (e.g., "[G-OLD-001] still open").
