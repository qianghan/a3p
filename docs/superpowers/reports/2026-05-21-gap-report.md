# AgentBook GTM Gap Report — 2026-05-21 (Phase 2 Synthesis)

**Source:** Phase 1 audit on branch `gtm-assessment-phase1` (commits `858b766` → `ac0e915`).
**Findings consolidated:** 382 (26 blockers, 238 launch, 86 polish, 8 nit).
**Methodology:** See spec §7. Gaps ranked by `points_reclaimed / effort`.

> **Read first:**
> 1. `2026-05-21-prior-findings-index.md`
> 2. `2026-05-21-code-review.md` (full evidence per file:line)
> 3. `2026-05-21-rubric-scorecard.md` (current 22/100, cap 85)

---

## Tier S — P0 Security (ship-stop today, even before launch)

These are exploitable in production today. If AgentBook has any external users right now, these need fixing **this week** regardless of GTM timeline.

### G-001 [BLOCKER-S] Tenant impersonation via `x-tenant-id` header
- **Found by:** code review A.3 + A.1 (`apps/web-next/src/lib/agentbook-tenant.ts:18-37`, `plugins/agentbook-core/backend/src/server.ts:38-42`)
- **Affects:** rubric #13 (-5), all ~150 routes under `/api/v1/agentbook*`, every financial record
- **Risk if shipped:** Any unauthenticated request with `x-tenant-id: <victim-uuid>` reads/writes that tenant's data. Falls back to literal `'default'` if header absent.
- **Effort:** M (~2 days)
- **Fix:** Resolve tenant from authenticated session (NextAuth JWT or signed cookie), not from header. Reject if no auth context. Add HMAC-signed tenant claim for service-to-service.
- **Rubric points reclaimed:** +5 (Tier 4 #13 from 0/5 → 5/5 partial)

### G-002 [BLOCKER-S] Unauthenticated tenant switcher
- **Found by:** A.3 (`apps/web-next/src/app/api/v1/agentbook/switch-tenant/route.ts:24-54`)
- **Affects:** rubric #13; combined with G-001 = full cross-tenant takeover
- **Risk if shipped:** `GET /switch-tenant?id=<any-uuid>` sets `ab-tenant` cookie with no auth or allowlist.
- **Effort:** S (~4h)
- **Fix:** Require authenticated session; lookup the user's allowed tenants from membership table; reject if requested tenant not in allowlist.
- **Rubric points reclaimed:** included in G-001

### G-003 [BLOCKER-S] Admin LLM-config endpoint — no auth + plaintext apiKey
- **Found by:** A.1 + A.3 (`plugins/agentbook-core/backend/src/server.ts:1546-1620`, `apps/web-next/src/app/api/v1/agentbook-core/admin/llm-configs/**`)
- **Affects:** rubric #13; API-key exfiltration; ability to flip global `isDefault` clearing every tenant's default
- **Risk if shipped:** Any request returns plaintext Gemini API key for any tenant. Combined with G-001: anonymous key exfiltration.
- **Effort:** S (~4h)
- **Fix:** Require admin role check; redact `apiKey` on read (`****` + last4); add per-tenant scoping; store keys encrypted-at-rest via envelope key.
- **Rubric points reclaimed:** included in G-001

### G-004 [BLOCKER-S] Stripe webhook signature missing — expense plugin
- **Found by:** A.2 (`plugins/agentbook-expense/backend/src/server.ts:915-945`)
- **Affects:** rubric #6, #13; financial integrity
- **Risk if shipped:** Forged `payment_intent.succeeded` events accepted, can record fake payments + post fake journal entries.
- **Effort:** XS (~2h)
- **Fix:** Delete this duplicate handler OR add `stripe.webhooks.constructEvent` with raw body. The canonical handler at `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/route.ts` is correct — prefer deletion.
- **Rubric points reclaimed:** +1 (#13)

### G-005 [BLOCKER-S] Stripe webhook signature missing — invoice plugin `/stripe/checkout-completed`
- **Found by:** A.2 (`plugins/agentbook-invoice/backend/src/server.ts:2001-2072`)
- **Affects:** rubric #6, #13; can flip any invoice to `paid` + post fake JE
- **Risk if shipped:** Free-money exploit on any deployed AgentBook instance.
- **Effort:** XS (~2h)
- **Fix:** Delete this duplicate handler OR add signature verification. Recommend deletion — Stripe webhook logic should live in one place.
- **Rubric points reclaimed:** +2 (#6 + #13)

### G-006 [BLOCKER-S] Public invoice endpoint enumerable
- **Found by:** A.2 (`plugins/agentbook-invoice/backend/src/server.ts:2078-2114`)
- **Affects:** rubric #16 (legal/data rights), customer trust, GDPR-style PII leak
- **Risk if shipped:** `GET /invoices/:id/public` returns client name, line items, amounts to anyone with a UUID. Combined with sequential `INV-YYYY-NNNN` numbering nearby, enumeration is trivial.
- **Effort:** S (~4h)
- **Fix:** Require signed access token in query (HMAC of `invoiceId+tenantId+exp`). Reject unsigned. Stop sequential numbering (use UUID-only or HMAC-derived).
- **Rubric points reclaimed:** +1 (#16)

### G-007 [BLOCKER-S] `resolveAgentbookTenant` + `/telegram/resolve-chat` bot-token leak
- **Found by:** A.1 (`plugins/agentbook-core/backend/src/server.ts:227-260`)
- **Affects:** rubric #13; cross-tenant Telegram hijack
- **Risk if shipped:** Anyone who guesses or learns a bot token gets the matching tenantId and can auto-register their chatId.
- **Effort:** S (~4h)
- **Fix:** Require server-to-server shared-secret header; stop auto-registering chatIds without explicit user opt-in flow.
- **Rubric points reclaimed:** included in G-001

### G-008 [BLOCKER-S] Cross-tenant `findFirst({id})` — multiple sites
- **Found by:** A.1, A.2, A.3 (`server.ts:3324`, expense `server.ts:286`, expense `server.ts:706`, expense `server.ts:792`, invoice `server.ts:2014`, plus ~6 more sites)
- **Affects:** rubric #13; cross-tenant data leak via UUID collision or known IDs
- **Risk if shipped:** Plaid sandbox sees deterministic account IDs across tenants; tenant B linking to same sandbox sees zero imports because tenant A's row exists. In production, UUID collision is improbable but the leak channel is real (e.g., insider, log analysis).
- **Effort:** M (~1 day) — find all, fix pattern, add lint
- **Fix:** Add `tenantId` to every `findFirst({where:{id}})` / `findMany({where:{id:{in:...}}})`. Add ESLint rule banning bare-id lookups on multi-tenant models.
- **Rubric points reclaimed:** included in G-001

### G-009 [BLOCKER-S] Line tables lack `tenantId` field (defense-in-depth)
- **Found by:** A.5 (`schema.prisma:1514` AbJournalLine, `:1686` AbExpenseSplit, `:1926` AbInvoiceLine)
- **Affects:** rubric #13; combined with G-008, direct queries can't be tenant-filtered without joining parent
- **Risk if shipped:** No way to enforce tenant isolation at the line-table level. Any direct query (analytics, ad-hoc) can leak.
- **Effort:** M (~1-2 days; schema migration + backfill)
- **Fix:** Add `tenantId String` field + `@@index([tenantId])` on all three line tables. Backfill from parent. Add Prisma extension that injects tenantId into every query for these models.
- **Rubric points reclaimed:** included in G-001

---

## Tier A — Agent-DNA blockers (rubric auto-fail clauses)

Each of these triggers the rubric's 85-point cap. Closing them lifts the cap to where Tier 1 raw score becomes the ceiling.

### G-010 [BLOCKER-A] Confirm gate broken — destructive ops execute BEFORE confirm prompt
- **Found by:** A.1 (`plugins/agentbook-core/backend/src/agent-brain.ts:303` → `server.ts:3282-3315`)
- **Affects:** rubric auto-fail (cap at 85), Tier 1 #3 (-3 deduction), financial correctness
- **Risk if shipped:** Already shipped. Every "are you sure?" prompt in Telegram fires AFTER the action ran. `confirmBefore: true` flag in manifests is decorative.
- **Effort:** M (~3 days)
- **Fix:** Split `classifyAndExecuteV1` into (a) `classifyOnly` returning intent+params, and (b) `executeSkill` that runs only after assessComplexity + user confirm. Add integration test asserting send-invoice does NOT call Stripe before confirm.
- **Rubric points reclaimed:** +6 (auto-fail cap lift + #3 from 0/10 → ~6/10)

### G-011 [BLOCKER-A] Skill routing is hardcoded regex chain
- **Found by:** A.1 (`server.ts:2480-2522`, ~50 inline exclusion regexes)
- **Affects:** rubric auto-fail (cap at 85), Tier 1 #2 (-4 deduction)
- **Risk if shipped:** Adding any skill requires touching a 50-line regex chain. Antithesis of "skills first-class."
- **Effort:** L (~5 days)
- **Fix:** Move per-skill exclusion patterns into `BUILT_IN_SKILLS` manifest as `excludePatterns: string[]`. Replace classify regex chain with: for each manifest entry, test `matchPatterns` + `excludePatterns`, score, return highest. Delete the inline chain.
- **Rubric points reclaimed:** +4 (Tier 1 #2 from 0/12 → 4/12) + auto-fail cap lift

### G-012 [BLOCKER-A] No web `PlanPreview` component
- **Found by:** A.4 (zero matches for `PlanPreview` / `Proceed/Cancel` / `plan.steps` in `apps/web-next/src` or `plugins/*/frontend/src`)
- **Affects:** rubric auto-fail (cap at 85), Tier 1 #1 (-2) and #3 (-2)
- **Risk if shipped:** Web chat (if it exists) executes plans silently. Users can't preview/cancel.
- **Effort:** M (~3 days)
- **Fix:** Build `<PlanPreview>` React component rendering steps list + Proceed/Cancel buttons. Wire to agent-message response. Match the existing Telegram inline-keyboard pattern from `agent-brain-v2-design.md`.
- **Rubric points reclaimed:** +4 (Tier 1 #1+#3) + auto-fail cap lift

### G-013 [BLOCKER-A] 22 form-only dashboard pages (rubric #1 auto-deduction)
- **Found by:** A.4 (22 launch findings on form-only paths)
- **Affects:** rubric Tier 1 #1 (-44 capped at -12 = zeroed)
- **Risk if shipped:** Product is SaaS-with-chatbot on web, not agent-native.
- **Effort:** XL (~10 days) — actually fixing this requires rebuilding most of the web UX
- **Fix:** Two-pronged: (a) wire receipt dropzone to OCR endpoint immediately (4h — kill obvious theater); (b) refactor onboarding to agent-driven conversation; (c) for the remaining pages, EITHER add chat-equivalent skills OR explicitly mark them as "advanced view" with chat-first banner.
- **Rubric points reclaimed:** +8 (Tier 1 #1 0/12 → 8/12 if 14 of 22 paths fixed/exempted)

### G-014 [BLOCKER-A] Conversation context ignored by fast paths
- **Found by:** A.1 + verified G-OLD-018 (`server.ts:2582`)
- **Affects:** rubric Tier 1 #4 (multi-turn coherence), agent quality
- **Risk if shipped:** "Fix it", "the last one", "that one" only work in the Stage-3 LLM fallback. Stage-1 shortcuts + Stage-2 regex ignore convCtx.
- **Effort:** M (~3 days)
- **Fix:** Add `resolveReferents(text, convCtx)` step BEFORE classify. Replace "fix it" / "that" with concrete IDs from recent context before pattern matching.
- **Rubric points reclaimed:** +1 (Tier 1 #4 multi-turn)

### G-015 [BLOCKER-A] 22 proactive handlers not wired to cron
- **Found by:** A.1 + verified G-OLD-011 (`server.ts:*` — no scheduler imports, no nightly proactive-alert producer)
- **Affects:** Tier 2 #8 (advisor), entire proactive-guidance promise
- **Risk if shipped:** Product markets "an agent that watches your books" but delivers zero proactive output.
- **Effort:** M (~2 days)
- **Fix:** Add Vercel Cron entry calling `POST /api/v1/agentbook/cron/proactive-handlers`. Implement the route to enumerate active tenants × 22 handlers, invoke each, dispatch ProactiveMessage via Telegram adapter. Add per-handler enable/disable in tenant config.
- **Rubric points reclaimed:** +2 (Tier 2 #8 2/4 → 4/4)

### G-016 [BLOCKER-A] No per-skill metrics
- **Found by:** A.1 (auto-deduct -2 on rubric #2)
- **Affects:** rubric Tier 1 #2 (-2)
- **Risk if shipped:** Cannot tell which skills are degrading; no signal for rollout/rollback.
- **Effort:** S (~1 day)
- **Fix:** Add `AbSkillRun` table (skillName, tenantId, status, latencyMs, tokenCost, createdAt) + write on every classifyAndExecuteV1 outcome + add `/agent/skills/metrics` aggregation endpoint + simple admin UI.
- **Rubric points reclaimed:** +2 (Tier 1 #2)

---

## Tier B — Data integrity & financial correctness

### G-017 [BLOCKER-B] `taxEstimate.effectiveRate` field doesn't exist → NaN%
- **Found by:** A.1 (`server.ts:861, 947, 1235, 1944` references nonexistent column)
- **Affects:** rubric Tier 2 #7 (tax)
- **Risk if shipped:** Every "Effective rate" in tax responses renders "NaN%". Trust-killer.
- **Effort:** XS (~1h)
- **Fix:** Compute on the fly: `effectiveRate = totalTaxCents / max(grossRevenueCents, 1)`. OR add the column to `AbTaxEstimate` and backfill.
- **Rubric points reclaimed:** +1 (#7 quality)

### G-018 [BLOCKER-B] `monthlyBurnCents` math is count-based, not calendar-based
- **Found by:** A.1 (`server.ts:865`)
- **Affects:** Tier 2 #8 (advisor)
- **Risk if shipped:** Advisor displays wrong burn-rate for any user not spending exactly 30 expenses/month.
- **Effort:** S (~4h)
- **Fix:** `groupBy date_trunc('month')` over trailing 90 days.
- **Rubric points reclaimed:** included in G-015

### G-019 [BLOCKER-B] Plaid access tokens in process-local Map
- **Found by:** A.2 (`plugins/agentbook-expense/backend/src/server.ts:655-656`)
- **Affects:** Tier 3 #12 (Plaid sync)
- **Risk if shipped:** Vercel cold starts drop tokens; users see "0 imported" silently on next sync.
- **Effort:** S (~1 day)
- **Fix:** Persist encrypted `accessToken` on `AbBankAccount`. Load on every sync.
- **Rubric points reclaimed:** +1 (#12)

### G-020 [BLOCKER-B] No idempotency on financial POSTs
- **Found by:** A.1, A.2, A.3 (multiple — `POST /expenses`, `POST /invoices`, `POST /payments`, `POST /journal-entries`)
- **Affects:** Tier 2 #5, #6; data integrity broadly
- **Risk if shipped:** Network blips → duplicate expenses, duplicate invoice numbers (409), duplicate payments → double-billing → ledger imbalance.
- **Effort:** M (~2 days) for shared helper + ~30min per endpoint
- **Fix:** Add `AbIdempotencyKey` table (key, tenantId, endpoint, requestHash, responseJson, createdAt). Reusable middleware: read `Idempotency-Key` header, check, return cached response or proceed-and-store.
- **Rubric points reclaimed:** +2 (Tier 2 #5+#6)

### G-021 [BLOCKER-B] `AbJournalEntry` lacks idempotency unique constraint
- **Found by:** A.5 (`schema.prisma:1496`)
- **Affects:** Tier 2 #5; trial balance correctness
- **Risk if shipped:** Cron retries / webhook replays post duplicate journal entries → trial balance silently broken.
- **Effort:** S (~4h; migration + backfill dedup)
- **Fix:** Add `@@unique([tenantId, sourceType, sourceId])`. Pre-flight check + dedup existing rows.
- **Rubric points reclaimed:** included in G-020

### G-022 [BLOCKER-B] Domain plugins bypass billing gates
- **Found by:** A.2 (verified: `checkQuota`/`incrementUsage`/`canUseFeature` never called in expense/invoice/tax plugin server.ts)
- **Affects:** Tier 3 #11 (billing/monetization); revenue
- **Risk if shipped:** Free-tier users get unlimited usage. Combined with quota fails-open on DB errors → no enforcement at all.
- **Effort:** M (~2 days)
- **Fix:** Add middleware to each plugin that checks quota before LLM/Plaid/email-heavy operations. Quota fails-CLOSED on DB errors with retry + alert.
- **Rubric points reclaimed:** +2 (#11)

### G-023 [LAUNCH-B] State fields are free-form strings, not enums
- **Found by:** A.5 (`AbAccount.accountType`, `AbExpense.status`, `AbInvoice.status`, `AbConvThread.status`, etc.)
- **Affects:** Tier 4 #14 (observability); reliability
- **Risk if shipped:** Typos silently break index filters (e.g., `status: 'paid '` with trailing space).
- **Effort:** L (~3 days; enum addition + backfill + audit existing values)
- **Fix:** Add Prisma enums for each state machine. Migrate existing values. Add validation at API boundary.
- **Rubric points reclaimed:** +1 (#14)

### G-024 [LAUNCH-B] OCR auto-execute bypasses verify-then-commit framework
- **Found by:** A.2 (`expense/server.ts:1102-1124`)
- **Affects:** Tier 2 #5 (bookkeeping); G-OLD-001 still partially open
- **Risk if shipped:** Telegram photo creates uncategorized confirmed expense with no JE, no status, no source — invisible to P&L but on list page.
- **Effort:** S (~1 day)
- **Fix:** OCR auto-create must set `status: 'pending_review'` + `source: 'telegram_photo'` + route through review queue confirm flow.
- **Rubric points reclaimed:** +1 (#5)

### G-025 [LAUNCH-B] Schema TZ bug (server-local Date instead of tenant TZ)
- **Found by:** A.1 (`server.ts:412`, A.2 expense `:154-160`)
- **Affects:** Tier 2 (period-aware reports)
- **Risk if shipped:** Asia-Pacific tenants post "Mar 31" → resolves to Apr 1 UTC → wrong fiscal period.
- **Effort:** S (~1 day)
- **Fix:** Centralize date resolution through `tenantTimezone(tenantId, dateString)` helper. Use Luxon or date-fns-tz. Migrate all `new Date(date)` calls in financial paths.
- **Rubric points reclaimed:** +1 (#5)

---

## Tier C — Operational reliability (launch-blockers but not security)

### G-026 [LAUNCH-C] Missing timeouts on LLM + skill execution
- **Found by:** A.1 (`server.ts:870-896` callGemini, `:3282-3315` classifyAndExecuteV1)
- **Affects:** Tier 4 #14 (observability), Tier 2 quality
- **Risk if shipped:** Hung downstream stalls webhook indefinitely.
- **Effort:** XS (~2h)
- **Fix:** Wrap in `Promise.race` with 20s ceiling (Gemini) and 30s (skill HTTP). Add `AbortController`.
- **Rubric points reclaimed:** +1 (#14)

### G-027 [LAUNCH-C] No structured logging / observability stack
- **Found by:** A.1 + scorecard #14
- **Affects:** Tier 4 #14
- **Risk if shipped:** Can't debug production incidents.
- **Effort:** M (~2 days)
- **Fix:** Add Pino logger + Sentry SDK. Replace `console.log/warn/error` with structured logs. Add `requestId` propagation. Set up Sentry alerts for unhandled rejection + 5xx rate.
- **Rubric points reclaimed:** +2 (#14)

### G-028 [LAUNCH-C] Empty body undo + silent error swallowing
- **Found by:** A.1 (`agent-brain.ts:201-210`)
- **Affects:** Tier 1 #3 (undo); user trust
- **Risk if shipped:** "Undone: X" message shown even when reverse fetch 500'd.
- **Effort:** XS (~2h)
- **Fix:** Don't pop undo stack until reverse-call success. Surface failure with explicit message.
- **Rubric points reclaimed:** +0.5 (#3)

### G-029 [LAUNCH-C] Missing tests for agent-brain / planner / evaluator / memory
- **Found by:** A.1 + A.5 (`__tests__/` only has immutability + journal-validation, hard-coded objects not actual Express routes)
- **Affects:** Tier 4 #14 (observability via test signal); regression risk
- **Risk if shipped:** Any agent-brain refactor (which we need for G-010, G-011, G-012, G-014) has no regression net.
- **Effort:** L (~5 days)
- **Fix:** Add supertest-based integration tests for: session-confirm flow, undo, complexity assessment, plan execution, memory correction, idempotency. Mock callGemini via dependency injection (already a clean seam at `agent-brain.ts:28`).
- **Rubric points reclaimed:** +1 (#14); enables safe execution of G-010/011/012/014

### G-030 [LAUNCH-C] Duplicate `.spec 2.ts` files in tests/e2e/nightly/
- **Found by:** A.5 (8 macOS finder-copy artifacts; stale assertions reference `/dashboard` vs canonical `/agentbook`)
- **Affects:** CI signal (158/158 baseline may be inflated)
- **Risk if shipped:** Stale tests give false confidence.
- **Effort:** XS (~30min)
- **Fix:** `git rm tests/e2e/nightly/*\ 2.ts tests/e2e/*\ 2.ts tests/e2e/playwright.config\ 2.ts`. Re-run baseline.
- **Rubric points reclaimed:** observability+test-integrity benefit

---

## Tier D — Agent-first refactors (rubric Tier 1 reclamation)

### G-031 [LAUNCH-D] Receipt-upload dropzones are non-functional theater
- **Found by:** A.4 (`NewExpense.tsx`, `Receipts.tsx`)
- **Affects:** rubric Tier 1 #1 (form-only count), Tier 3 #10 (onboarding first-15-min)
- **Risk if shipped:** Marketing pitch: "drop receipts, we'll extract details." Reality: dropzone has no onClick. First-15-min failure.
- **Effort:** S (~1 day)
- **Fix:** Wire dropzone → `POST /receipts/upload-blob` → `POST /receipts/ocr` → render extracted fields with confirm. Inline confirm UI matching Telegram pattern.
- **Rubric points reclaimed:** +2 (Tier 1 #1: -2 deduction removed) + +2 (Tier 3 #10)

### G-032 [LAUNCH-D] Onboarding is 7-step traditional wizard (anti-agent-first)
- **Found by:** A.4 (`Onboarding.tsx`)
- **Affects:** Tier 3 #10 (-4); Tier 1 #1 brand consistency
- **Risk if shipped:** First contact with "agent-native" product is a SaaS wizard.
- **Effort:** L (~5 days)
- **Fix:** Replace step-form with a chat-driven onboarding: agent asks one question at a time (business type, jurisdiction, currency, etc.), confirms each, persists at end. Reuse the slot-fill skill pattern (already used for invoice creation).
- **Rubric points reclaimed:** +4 (#10)

### G-033 [LAUNCH-D] UI panels fetch independently, don't sync with chat actions
- **Found by:** A.4 (`/agentbook/expenses`, `/agentbook/invoices`, others)
- **Affects:** rubric Tier 1 #1 (-3); user perception of "agent + UI are one product"
- **Risk if shipped:** User logs expense via chat, opens dashboard, doesn't see it without refresh.
- **Effort:** L (~5 days)
- **Fix:** Subscribe dashboard tables to a shared agent-session event store (Server-Sent Events or polling on `lastAgentActionAt`). Invalidate React Query cache on agent action.
- **Rubric points reclaimed:** +3 (Tier 1 #1)

---

## Tier E — Domain polish (post-launch)

### G-034 [LAUNCH-E] Invoice "PDF" is actually HTML
- **Found by:** A.2 (G-OLD-006 verified open; `invoice/server.ts:1466-1505`)
- **Effort:** S (~1 day) — Puppeteer or React-PDF
- **Fix:** Generate real PDF; serve `application/pdf`.

### G-035 [LAUNCH-E] CSV import is naive `split(',')` (breaks on quoted commas)
- **Found by:** A.2 (`expense/server.ts:2099-2168`)
- **Effort:** XS (~2h) — drop in `papaparse`

### G-036 [LAUNCH-E] N+1 queries in 5 hot paths
- **Found by:** A.1 + A.2 (`/financial-snapshot`, `/client-health`, `/budgets/status`, others)
- **Effort:** M (~2 days) — convert each to `groupBy`

### G-037 [LAUNCH-E] CA tax e2e missing
- **Found by:** A.5 + G-OLD-013
- **Effort:** S (~1 day) — add spec mirroring US flow

### G-038 [LAUNCH-E] LLM context overpacking (5-10K tokens per `/ask`)
- **Found by:** A.1 (`server.ts:799-816, 992-997`)
- **Effort:** S (~1 day) — intent-aware context builder

### G-039 [LAUNCH-E] Missing tenantId on Plaid token lookups (G-008 already covers; this is overlap)
- **Already in G-008**

### G-040 [POLISH-E] No memory pruning / TTL job
- **Found by:** A.1 (`agent-memory.ts:201`)
- **Effort:** XS (~2h) — nightly cron

---

## Effort summary (top-tier gaps)

| Tier | Gaps | Total effort | Engineer-days |
|------|------|--------------|---------------|
| S — Security P0 | G-001..G-009 | 11 days | ~2 weeks |
| A — Agent-DNA | G-010..G-016 | 20 days | ~4 weeks |
| B — Data integrity | G-017..G-025 | 12 days | ~2.5 weeks |
| C — Reliability | G-026..G-030 | 8 days | ~1.5 weeks |
| D — Agent-first refactor | G-031..G-033 | 11 days | ~2 weeks |
| E — Domain polish | G-034..G-040 | 8 days | ~1.5 weeks |
| **Total** | **40 gaps** | **70 engineer-days** | **~14 weeks solo, ~7 weeks parallelized** |

---

## Rubric projection

If we close gaps in tiered order, the score climbs as:

| Closed | Estimated score | Notes |
|--------|-----------------|-------|
| Nothing | **22 / 100** (cap 85) | Current state |
| Tier S only | **30 / 100** (cap 85) | Security defensible, agent-DNA still failing |
| Tier S + A | **50 / 100** (cap lifted) | Agent-native restored; auto-fail clauses cleared |
| Tier S + A + B | **62 / 100** | Financial integrity restored; revenue gates working |
| Tier S + A + B + C | **70 / 100** | Operationally ready |
| Tier S + A + B + C + D | **80 / 100** | Web is agent-first |
| All tiers (including stream B test suite from original plan) | **88-92 / 100** | Within striking distance of 95 |
| All tiers + 1 dedicated polish week | **≥95 / 100** | Hitting the bar |

**Realistic path to ≥75 (safety-to-ship line):** Tiers S + A + most of B = **~5-6 weeks of focused work** (1 senior engineer + Claude).
**Realistic path to ≥95:** Add C + D + polish = **~10-12 weeks total**.

---

## Decisions deferred to user

1. **Tier S timeline:** these are P0 today. Should we drop everything and ship a security patch this week, separate from the 4-week GTM plan?
2. **Tier D scope:** the 22 form-only paths represent ~10 days of UI work. Could we shrink the product surface for v1 launch (e.g., remove the dashboard pages that have no chat parity, ship as "Telegram-first with read-only dashboard")?
3. **G-032 onboarding rewrite:** would you accept a hybrid where the wizard stays for now but is preceded by an agent "let me help you set this up" greeting that walks the user through it? Smaller scope (~2 days) instead of full rewrite.
4. **Test suite scope (originally Stream B):** these were deferred from option-c. Should they be added back as Tier C+ work, or skipped until we hit the safety-to-ship line?
