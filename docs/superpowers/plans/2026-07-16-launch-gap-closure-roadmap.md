# Launch Gap Closure Roadmap — US / CA / AU

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute each PR below. This is a roadmap document — each PR gets its own detailed implementation plan (docs/superpowers/plans/YYYY-MM-DD-<pr-name>.md) written immediately before that PR starts, following superpowers:writing-plans, exactly as every prior PR this session has been handled.

**Goal:** Close every Critical and Medium+ gap identified in the [AgentBook US/CA/AU Launch Readiness assessment](https://claude.ai/code/artifact/942568ca-730e-42aa-a65a-798746d2af1d) (2026-07-16), so the product can honestly be launched in all three target regions for students, individuals, sole traders, and freelancers.

**Source of truth:** the assessment above, plus the four research passes behind it (billing/pricing audit, feature-coverage matrix, stability/bugs audit, legal/compliance check). Every item below traces to a specific finding in one of those.

**Scope discipline:** each PR fixes exactly what's broken, reusing existing patterns and components wherever one already exists (the AU tax logic, the working `AddOnCheckoutModal`, the `useTenantCurrency()` hook, the existing disclaimer component) rather than building anything new that isn't strictly required to close the gap. No PR adds a feature beyond what the assessment flagged.

## Severity key

- **Critical** — actively wrong output, money-integrity risk, or a completely non-functional path for a named target persona/region.
- **Medium** — real, user-facing or compliance-facing, but not actively harmful today; safe to sequence after the Criticals.

---

## PR-1: Wire AU (and CA) into the live tax engine — Critical

**Why:** The live Tax Dashboard applies US brackets to AU income, returns `$0` for the Medicare Levy, shows US IRS quarterly dates to AU tenants, and displays a hardcoded `$` regardless of the tenant's actual currency. The correct AU/CA logic already exists in `packages/agentbook-jurisdictions` — this PR is entirely about calling it from the live routes that currently don't.

**Files:** `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`, `plugins/agentbook-tax/backend/src/server.ts` (`getBrackets()`, `calcSelfEmploymentTax()`, `getQuarterlyDeadlines()`), `plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx` (currency formatter), plus a sweep of the other dashboard widgets flagged with hardcoded `$` (`Ledger.tsx`, `ThisMonthStrip.tsx`, `CatchUpBanner.tsx`, `AttentionItem.tsx`, `ForwardView.tsx`, and the expense-plugin pages `Bills.tsx`/`BankConnection.tsx`/`Budgets.tsx`/`Receipts.tsx`/`BankReview.tsx`), and `apps/web-next/src/lib/agentbook-invoice-pdf.ts`'s `fmtMoney()` (missing AUD case).

**Scope boundary:** import and call the existing `au`/`ca` jurisdiction packs; do not modify the packs themselves. Currency fix is "use the existing `useTenantCurrency()` hook everywhere it's missing," not a new formatting system.

**Tasks (indicative — full plan written at execution time):**
1. `tax/estimate/route.ts` + `server.ts`: replace the hardcoded `us`/`ca` bracket map and the `calcSelfEmploymentTax()` fallback-to-zero with real lookups against `packages/agentbook-jurisdictions/src/{us,ca,au}/tax-brackets.ts` and `self-employment-tax.ts`.
2. `server.ts`'s `getQuarterlyDeadlines()`: add the `au` branch using `au/calendar-deadlines.ts`'s real BAS/PAYG dates.
3. `TaxDashboard.tsx`: replace the hardcoded `Intl.NumberFormat('en-US', {currency:'USD'})` with the same `useTenantCurrency()` pattern its sibling pages already use.
4. Sweep the remaining hardcoded-`$` widgets listed above to the same pattern; add the missing AUD case to `agentbook-invoice-pdf.ts`.

---

## PR-2: Jurisdiction-aware chart of accounts — Critical

**Why:** Onboarding tells every new tenant "we'll create a chart of accounts based on your tax jurisdiction," then always seeds the US Schedule-C chart regardless of jurisdiction — a stale `TODO` admits it. AU and CA tenants start their books with wrong tax-category labels on day one.

**Files:** `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts`, the mirrored logic in `plugins/agentbook-core/backend/src/server.ts`.

**Scope boundary:** branch on `AbTenantConfig.jurisdiction` using the chart-of-accounts packs that already exist for `ca`/`au`; no new chart design.

---

## PR-3: AU bank sync (Plaid) — Critical

**Why:** Both Plaid integrations hardcode `country_codes: [CountryCode.Us, CountryCode.Ca]`. An AU user clicking "Connect bank" gets a Link session scoped to institutions that don't exist for them.

**Files:** `apps/web-next/src/lib/agentbook-plaid.ts`, `apps/web-next/src/lib/agentbook-personal-plaid.ts`.

**Scope boundary:** add `CountryCode.Au`. Before shipping, confirm Plaid's sandbox/live product actually lists AU institutions for this app's Plaid account — this is a one-line code change but needs a real Plaid Link sandbox check, not just a compile-time fix, since Plaid's institution coverage is configured per-app on their side too.

---

## PR-4a: Business model consistency — one source of truth for pricing — Critical

**Why:** Every price in this product is a separately hardcoded literal — marketing page strings, MDX doc strings, seed-script constants — with no shared source of truth anywhere. That's the root cause of a real, confirmed mismatch: the Pro plan is `priceCents: 1900` ($19.00/mo) in `agentbook/seed-billing-plans.ts`, but the marketing page says **"$20 a month"** in three separate places. It's also why nothing catches this kind of drift automatically. Beyond that one bug, this PR establishes the actual policy so it doesn't recur: every add-on gets a price in every target region (us/ca/au), using one documented derivation rule, not an ad-hoc one-off each time a region is added.

**Files:** new `apps/web-next/src/lib/pricing-copy.ts` (or equivalent shared constants module), `apps/web-next/src/app/page.tsx` (marketing prices — currently 3 separate hardcoded `$20` strings), `agentbook/seed-billing-plans.ts`, `bin/seed-{tax-fast-track,student-success,personal-insights,startup-benefit}-addon.ts`, a new consistency test.

**Scope boundary:** extract prices into one shared module that both the seed scripts and the marketing/docs copy import from — this is a refactor of *where prices live*, not a repricing. Where marketing copy and the actual charged Stripe price disagree (the $19/$20 case), the marketing copy is corrected to match what's actually charged, never the other way around — never silently reprice something a real subscriber is already paying.

**Tasks (indicative):**
1. Confirm which figure is correct for Pro ($19 is what `BillPlan`/Stripe actually charges — treat as authoritative unless told otherwise) and fix the 3 hardcoded "$20" instances in `page.tsx` to match.
2. Extract a single shared pricing-constants module covering the core plans (Free/Pro/Business) and all four add-ons' per-region prices; have the seed scripts and marketing/docs pull from it instead of duplicating the numbers.
3. Document the actual AU/CA pricing-derivation convention already in use (nominal round-number uplift, not strict FX conversion) as a comment in that module, so the next new region or add-on follows one rule instead of reinventing it.
4. Add a small test that reads live `BillPlan`/`BillAddOnPrice` rows and asserts they match the shared constants module — turns "someone notices a mismatch by reading the site" into an automated, CI-visible check.
5. Note (product decision, not a code fix): the Business plan ($49/mo) isn't shown on the marketing page at all today — flag for a decision on whether that's intentional (invite-only?) rather than assuming it should be added.

---

## PR-4b: Complete add-on management UI (subscribe, view, cancel) — Critical (largest PR)

**Why:** `tax_fast_track`, `student_success`, and `personal_insights` all have live Stripe prices in every region now (via PR #252), but there is no frontend flow anywhere that lets a user complete a purchase, see what they're subscribed to, or cancel it. Checking turned up more of this gap than the original assessment surfaced: a cancel API route (`POST /me/addons/[code]/cancel`) already exists and works, but nothing in the UI calls it; the list endpoint (`GET /me/addons`) only checks one add-on via a `?code=` query param, so there's no "show me all my active add-ons" capability at the API layer either; and the existing Settings → Billing tab shows the core plan only — no add-ons, no payment method, no invoice history, not even a cancel button for the core plan. Only `startup_tax_benefits` (a different persona — startups, not this launch's target users) has a working *subscribe* flow, and even that has no corresponding *view/cancel* screen.

**Files:** `packages/ui/src/AddOnCheckoutModal.tsx` (reuse), a new `GET /api/v1/agentbook-billing/me/addons` list variant (the existing single-code route stays for its current callers), `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx`'s `BillingTab()` (add an "Add-ons" section — subscribe via the modal, view active subscriptions, cancel via the existing route), `apps/web-next/src/app/(dashboard)/personal/page.tsx` (fix the broken teaser to use this same pattern instead of its own broken direct-`/subscribe` call), the three add-ons' chat-gate messages in `plugins/agentbook-core/backend/src/server.ts` (point "enable it in Settings" at the real new location).

**Scope boundary:** reuse `AddOnCheckoutModal` and the already-existing cancel route as-is; the only new backend surface is the "list all my active add-ons" query (the cancel logic itself doesn't need to be built, just wired up). No new pricing tiers, no new add-ons, no invoice-history/payment-method UI beyond what's needed to show and manage add-on subscriptions — that's a separate, larger billing-UI project if wanted later. Prices shown in this UI must come from the live `BillAddOnPrice` rows (already true via existing resolve logic), never a hardcoded string — this is where PR-4a's source-of-truth work and this PR's UI meet.

**Tasks (indicative):**
1. Add a "list my active add-ons" capability (new query variant or a small new route) returning every `BillAddOnSubscription` for the tenant with add-on name/price/region/status.
2. Add an "Add-ons" section to `BillingTab()`: an "Available" list (subscribe via `AddOnCheckoutModal`, for all four add-ons) and an "Active" list (name, price actually being paid, a Cancel button wired to the existing `/me/addons/[code]/cancel` route).
3. Fix `personal/page.tsx`'s broken teaser to open the same modal instead of its own non-functional direct `/subscribe` call.
4. Update the three chat-gate 402 messages to point at this real Settings location.

---

## PR-5: Invoice + ledger integrity — Critical + Medium

**Why:** Three separate money-correctness bugs, all in the invoice/payment path: (a) manual payment recording has no idempotency check — a retry double-records cash; (b) Stripe-collected invoice payments silently post no journal entry at all, because the webhook looks up account codes `1010`/`1200` against a chart that actually uses `1000`/`1100`; (c) "invoice Acme $5000 for consulting" — a natural way to ask for an invoice — can get misrouted to `record-expense` because two skills' patterns both match and there's no deterministic tie-break (`db.abSkillManifest.findMany()` has no `orderBy`).

**Files:** `plugins/agentbook-invoice/backend/src/server.ts` (`POST /invoices/:id/payments`), `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts` (account-code lookup), `plugins/agentbook-core/backend/src/skill-routing.ts` / `built-in-skills.ts` (routing patterns + the `findMany()` query).

**Scope boundary:** fix the account-code constants and add the missing `orderBy`/idempotency check — don't redesign the skill-routing engine or the payment-recording flow beyond what's needed to make both deterministic and safe.

---

## PR-6: GST / sales-tax on invoices for AU and CA — Critical

**Why:** The AU GST engine (`au/sales-tax.ts`, correct 10% rate + BAS deadlines) and CA's equivalent exist but are never called from invoice creation — `taxCents` on an invoice is only ever displayed, never computed. For AU sole traders in particular, GST-inclusive invoices are a real BAS-lodgment requirement, not a nice-to-have.

**Files:** `plugins/agentbook-invoice/backend/src/server.ts` (invoice creation), the invoice-creation frontend (`NewInvoice.tsx` or equivalent) — add a tax-rate field.

**Scope boundary:** correct invoice math only — default the tax rate from the tenant's jurisdiction sales-tax pack, keep it editable, compute `taxCents` correctly. No BAS/GST-return filing or reporting UI; that's a separate, larger feature explicitly out of scope here.

---

## PR-7: Legal, trust & compliance — Critical + Medium

**Why:** Five separate but thematically linked gaps: (a) Privacy/Terms links are dead (`/terms`, `/privacy` 404; real routes are `/legal/terms`, `/legal/privacy`; no footer link at all) — a real trust problem for a product asking to connect a bank account; (b) the privacy policy names no jurisdiction-specific framework (PIPEDA, Privacy Act 1988) and never discloses Supabase or that financial data passes through Gemini; (c) no minimum-age clause or signup gate despite students being a named persona; (d) the "not tax advice" disclaimer exists on some tax pages but is missing from several others, most notably `WhatIf.tsx`, which produces synthetic what-if tax figures with zero caveat; (e) the refund/cancellation clause is a single generic sentence that doesn't address annual add-on pre-payment.

**Files:** `apps/web-next/src/app/page.tsx` (footer), `apps/web-next/src/app/(auth)/register/register-form.tsx` (link targets), `apps/web-next/src/app/legal/{privacy,terms}/page.tsx`, `plugins/agentbook-tax/frontend/src/pages/{Reports,WhatIf,PastFilings,TaxPackage,Quarterly,Analytics,CashFlow}.tsx` (add the existing disclaimer component where missing), the signup flow (age attestation).

**Scope boundary:** this is copy and disclosure work plus reusing the one existing disclaimer component everywhere it's missing — not new legal infrastructure. Content changes to the privacy policy should be drafted and then explicitly reviewed before publishing (see Global Constraints).

---

## PR-8: International-student & scholarship tax guidance — AU-aware — Medium

**Why:** Several chat-skill code paths hardcode a binary `jurisdiction === 'ca' ? 'Canada' : 'the United States'` — an AU student asking about their tax status today is told they're "in the United States" and given IRS rules.

**Files:** `plugins/agentbook-core/backend/src/server.ts` (the several ternaries flagged around lines 3878/3897/3941/3950/1461/1557/1558/1606/1613).

**Scope boundary:** replace each binary ternary with a proper three-way (`us`/`ca`/`au`) branch using real jurisdiction terms. Small, mechanical, but touches several call sites in one file — worth its own focused task.

---

## PR-9: Account deletion follow-through + error monitoring — Medium

**Why:** Two independent operational gaps: (a) the self-serve account-deletion request only logs an audit event promising a 30-day hard delete — no job actually performs it, which matters directly for AU/CA privacy-law expectations; (b) a Sentry-compatible error reporter exists in code but the package isn't installed and no DSN is configured in production, so the team currently finds out about breakage from an admin dashboard, not a page.

**Files:** a new cron entry (following the existing `vercel.json` cron pattern) for the hard-delete job, `apps/web-next/src/lib/logger.ts` (Sentry wiring), production env config (`SENTRY_DSN`).

**Scope boundary:** implement the deletion job the product already promises — don't redesign the deletion/export flow. For Sentry, wire the existing `reportError()` path to a real Sentry project; don't build new observability tooling.

---

## PR-10: Security hardening — tenant-id trust + CORS default — Medium

**Why:** Two smaller, security-flavored gaps surfaced in the stability audit: (a) the plugin backend trusts a plain header for tenant ID in one spot rather than verifying a session/token, unlike the hardened `resolveAgentbookTenant` path used elsewhere; (b) CORS defaults to allow-all when `CORS_ALLOWED_ORIGINS` is unset (a tracked issue, #92 in this repo).

**Files:** `plugins/agentbook-core/backend/src/server.ts:44`, `packages/plugin-server-sdk/src/server.ts:132-133`.

**Scope boundary:** close both gaps using the same verification discipline already established elsewhere in this codebase (`safeResolveAgentbookTenant`-style checks, fail-closed CORS) — no new auth architecture.

---

## PR-11: Web / MCP / Chatbot surface parity — Medium

**Why:** A dedicated audit of all three surfaces found the architecture already delivers parity "for free" in almost every case that matters — MCP is a single passthrough tool (`ask_agentbook`) into the exact same skill router Telegram and web chat use (`agent-brain.ts`'s `handleAgentMessage`), so any skill added to `BUILT_IN_SKILLS` is automatically available over all three transports with no extra MCP-side code, and no divergent/duplicated business logic was found anywhere. Expenses, invoices, tax reports, tax fast-track (start/answer/cancel/status), personal-finance transactions/snapshot, all three Student Success copilots, CPA handoff, and payroll all have genuine, verified parity across web, MCP, and chatbot today. Two real, narrow gaps remain, plus one stale piece of documentation:

1. **Tax fast-track "regenerate a stuck draft" is web-only.** The web UI's "Try again" button calls `POST /regenerate`; there's no equivalent skill, so chat/MCP users hit a dead end and are told in the response text to go use the web app instead.
2. **Personal-finance bank sync (Plaid connect/sync/disconnect) has no chat/MCP skill at all** — reasonable, since Plaid Link is an interactive browser widget that can't run inside a chat transport, but there's currently no explicit, friendly redirect message the way tax fast-track's regenerate already has one; a user asking to "connect my bank" via chat/MCP likely falls through to a generic, unhelpful response instead of being told where to go.
3. **CLAUDE.md documents "16 built-in skills."** The real count is 84, spanning bookkeeping, invoicing, tax (US/CA/AU), payroll, personal finance, and student success. Cheap to fix, and worth fixing so this doesn't mislead the next person (or agent) reasoning about what the chatbot/MCP surface can actually do.

**Files:** `plugins/agentbook-core/backend/src/built-in-skills.ts` (new `regenerate-tax-fast-track-draft` skill, following the exact pattern of the existing start/answer/cancel/status skills), `plugins/agentbook-core/backend/src/agent-brain.ts` (the regenerate skill's handler, and a friendly redirect response for Plaid-connect asks — mirroring the existing regenerate-redirect message's tone), `CLAUDE.md` (skill count + category summary).

**Scope boundary:** add the one missing skill using the established "Adding a new skill" pattern already documented in CLAUDE.md — no new MCP-side code is needed (MCP gets this automatically once the skill exists). For Plaid, this PR adds a graceful, explicit redirect message only — it does not attempt to build any interactive bank-connect flow into chat/MCP, since that's a genuine, accepted architectural constraint, not a bug.

---

## Explicitly out of scope for this roadmap

- The Plaid business-expense "connect-and-persist" open item (task #32) — already assessed as a verification/automation-speed gap, not a broken feature (5/5 recovery confirmed); tracked separately.
- The two chronic CI test failures caused by stale mocks (`agent-brain-confirm-flow.test.ts`/`agent-brain-confirm-gate.test.ts`) — no user-facing impact; fixing the mocks is welcome opportunistically but isn't a launch gap.
- Cookie-consent infrastructure — nothing to consent to today (no analytics/tracking installed); revisit only if analytics is added.
- Full BAS/GST return filing and reporting (as opposed to correct invoice-level GST math, which is PR-6's scope).
- Year-versioned tax brackets (currently hardcoded to 2025) — fine until the next tax year; not a launch blocker.
- Building an interactive bank-connect flow inside chat/MCP (Plaid Link requires a browser widget) — accepted architectural constraint, not a gap; PR-11 only adds a graceful redirect message for it.

## Global Constraints (apply to every PR above)

- Every fix reuses an existing, already-built pattern in this codebase (a jurisdiction pack, `useTenantCurrency()`, `AddOnCheckoutModal`, the existing add-on cancel route, the tax-disclaimer component, `safeResolveAgentbookTenant`'s verification discipline) rather than introducing a new one — this roadmap is about closing wiring gaps, not redesigning subsystems.
- **Pricing has exactly one source of truth from PR-4a onward.** Once the shared pricing-constants module exists, every future add-on, tier, or region gets its price added there first — marketing copy, docs, and seed scripts all read from it. No PR after PR-4a introduces a new hardcoded price literal anywhere.
- **Every add-on's region coverage is symmetric by construction.** us/ca/au get a price for every add-on this launch depends on (already true as of the earlier billing fix); the shared constants module (PR-4a) makes it structurally awkward to add a region to one add-on without adding it to the others, rather than relying on someone remembering to.
- **Any new user-facing capability ships as a `BUILT_IN_SKILLS` entry, not a web-only route, unless it genuinely requires an interactive widget the chat/MCP transport can't render** (payment collection, Plaid Link). Because MCP is a passthrough into the same skill router chat uses, this one habit is what keeps web/MCP/chatbot parity "free" going forward instead of needing another audit like PR-11 next time a feature ships.
- Legal-copy changes (PR-7) are drafted as a diff and explicitly called out for the user's own review before merging — this agent should not unilaterally finalize legal-document language beyond fixing structural gaps (broken links, missing disclaimer component instances) without a review checkpoint, since legal copy carries obligations beyond code correctness.
- Any step that touches production billing, production data migrations, or sends real user-facing communications still requires the same explicit stop-and-confirm this session has applied throughout — this roadmap does not pre-authorize those steps. Correcting a marketing-copy price to match what's actually charged is a copy fix, not a repricing, and does not require the same confirmation as changing what a real subscriber pays.
- Each PR gets the same treatment every prior PR this session received: design/plan self-review → subagent-driven-development execution → per-task review → final whole-branch review → CI → merge (never `--admin`) → build + deploy → verify.

## Suggested execution order

Most PRs are file-disjoint and could run in parallel across separate worktrees if throughput matters more than sequencing; suggested default order, front-loading the highest-severity/highest-blast-radius items:

1. PR-1 (tax engine wiring) — foundational AU correctness.
2. PR-2 (chart of accounts) — same theme, AU/CA onboarding correctness.
3. PR-3 (Plaid AU) — quick, high-impact.
4. PR-5 (invoice/ledger integrity) — money correctness, all regions.
5. PR-6 (GST on invoices) — builds on PR-5's invoice-creation context.
6. PR-4a (pricing source of truth) — do before 4b, since 4b's new UI should read prices from the module 4a creates, not duplicate them again.
7. PR-4b (add-on management UI) — largest lift, revenue-critical.
8. PR-7 (legal & trust) — no code dependencies on the above, can run in parallel any time.
9. PR-8 (international-student guidance) — small, independent.
10. PR-11 (surface parity — regenerate skill + Plaid redirect + doc fix) — small, independent, quick win.
11. PR-9 (deletion job + monitoring) — operational, independent.
12. PR-10 (security hardening) — independent.
