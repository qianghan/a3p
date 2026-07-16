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

## PR-4: Add-on checkout UI — Critical (largest PR)

**Why:** `tax_fast_track`, `student_success`, and `personal_insights` all have live Stripe prices in every region now, but there is no frontend flow anywhere that lets a user complete a purchase. Only `startup_tax_benefits` (a different persona) has a working checkout, via `packages/ui/src/AddOnCheckoutModal.tsx`. This is the single biggest revenue-blocking gap in the assessment.

**Files:** `packages/ui/src/AddOnCheckoutModal.tsx` (reuse, generalize if needed), a real "enable this add-on" entry point under Settings → Billing (new small component, following the existing Settings tab patterns), `apps/web-next/src/app/(dashboard)/personal/page.tsx` (fix the teaser button), the three add-ons' chat-gate messages in `plugins/agentbook-core/backend/src/server.ts` (update "enable it in Settings" copy to be accurate/actionable), and (small, folded in here rather than its own PR) the Pro-plan price display mismatch — `agentbook/seed-billing-plans.ts` says $19.00/mo, the marketing page says "$20 a month"; reconcile to one correct figure.

**Scope boundary:** reuse `AddOnCheckoutModal` as-is wherever its API allows; don't design a new payment UI. No new pricing tiers, no new add-ons — just make the three that already have live prices actually purchasable.

**Tasks (indicative):**
1. Confirm `AddOnCheckoutModal`'s props/API generalize cleanly to these three add-ons (it was built for one — check for any `startup`-specific assumptions).
2. Add an "Add-ons" section to Settings → Billing listing all four add-ons with subscribe buttons wired to the modal.
3. Fix `personal/page.tsx`'s broken teaser to open the modal instead of calling `/subscribe` directly.
4. Update the three chat-gate 402 messages to match the real entry point.
5. Reconcile the $19/$20 Pro price display mismatch.

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

## Explicitly out of scope for this roadmap

- The Plaid business-expense "connect-and-persist" open item (task #32) — already assessed as a verification/automation-speed gap, not a broken feature (5/5 recovery confirmed); tracked separately.
- The two chronic CI test failures caused by stale mocks (`agent-brain-confirm-flow.test.ts`/`agent-brain-confirm-gate.test.ts`) — no user-facing impact; fixing the mocks is welcome opportunistically but isn't a launch gap.
- Cookie-consent infrastructure — nothing to consent to today (no analytics/tracking installed); revisit only if analytics is added.
- Full BAS/GST return filing and reporting (as opposed to correct invoice-level GST math, which is PR-6's scope).
- Year-versioned tax brackets (currently hardcoded to 2025) — fine until the next tax year; not a launch blocker.

## Global Constraints (apply to every PR above)

- Every fix reuses an existing, already-built pattern in this codebase (a jurisdiction pack, `useTenantCurrency()`, `AddOnCheckoutModal`, the tax-disclaimer component, `safeResolveAgentbookTenant`'s verification discipline) rather than introducing a new one — this roadmap is about closing wiring gaps, not redesigning subsystems.
- Legal-copy changes (PR-7) are drafted as a diff and explicitly called out for the user's own review before merging — this agent should not unilaterally finalize legal-document language beyond fixing structural gaps (broken links, missing disclaimer component instances) without a review checkpoint, since legal copy carries obligations beyond code correctness.
- Any step that touches production billing, production data migrations, or sends real user-facing communications still requires the same explicit stop-and-confirm this session has applied throughout — this roadmap does not pre-authorize those steps.
- Each PR gets the same treatment every prior PR this session received: design/plan self-review → subagent-driven-development execution → per-task review → final whole-branch review → CI → merge (never `--admin`) → build + deploy → verify.

## Suggested execution order

Most PRs are file-disjoint and could run in parallel across separate worktrees if throughput matters more than sequencing; suggested default order, front-loading the highest-severity/highest-blast-radius items:

1. PR-1 (tax engine wiring) — foundational AU correctness.
2. PR-2 (chart of accounts) — same theme, AU/CA onboarding correctness.
3. PR-3 (Plaid AU) — quick, high-impact.
4. PR-5 (invoice/ledger integrity) — money correctness, all regions.
5. PR-6 (GST on invoices) — builds on PR-5's invoice-creation context.
6. PR-4 (checkout UI) — largest lift, revenue-critical.
7. PR-7 (legal & trust) — no code dependencies on the above, can run in parallel any time.
8. PR-8 (international-student guidance) — small, independent.
9. PR-9 (deletion job + monitoring) — operational, independent.
10. PR-10 (security hardening) — independent.
