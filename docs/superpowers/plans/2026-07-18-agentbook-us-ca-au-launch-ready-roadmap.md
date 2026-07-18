# AgentBook US/CA/AU Launch-Ready Roadmap (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute each PR in this roadmap. Each PR gets its own detailed implementation plan (via superpowers:writing-plans, at bite-sized-step granularity) generated immediately before that PR is executed — this document is the roadmap that sequences and scopes those per-PR plans, not the per-PR plans themselves. This mirrors the exact process already used to execute `2026-07-16-launch-gap-closure-roadmap.md` (11 PRs, all shipped).

**Goal:** Take AgentBook from "core features exist" to genuinely launch-ready and competitive against the top-10 accounting SaaS products in the US, Canada, and Australia — for the target persona (freelancers, sole traders, and micro-SMBs under ~$1M revenue) — closing every Critical/High/Medium-severity gap identified in the 2026-07-18 launch-readiness audit, market by market, with a mandatory competitive re-assessment gate after each market that loops back into the same phase until it is clean.

**Architecture:** Three sequential phases — Phase 1 (US), Phase 2 (CA), Phase 3 (AU) — each a self-contained sub-roadmap of PRs against the existing plugin/jurisdiction-package architecture (`packages/agentbook-jurisdictions`, `plugins/agentbook-tax`, `plugins/agentbook-invoice`, `plugins/agentbook-expense`, `plugins/agentbook-core`). No new architectural layer is introduced — every fix wires an already-existing, already-correct engine into the code path that currently bypasses it, or extends an existing per-jurisdiction table. Each phase ends with a non-implementation "Gate" task: a fresh, evidence-based competitive/SWOT re-assessment of that market. If the gate finds any open Medium-or-above-severity gap, the phase is not complete — new remediation PRs are appended to that phase and the gate re-runs after they land. Only a clean gate advances to the next phase.

**Tech Stack:** Next.js 15 (`apps/web-next`), Express plugin backends (`plugins/*/backend`), Prisma/Supabase Postgres, Stripe billing, Plaid (US/CA bank sync) + a to-be-selected CDR-accredited aggregator (AU bank sync), Gemini LLM (agent brain, document extraction), Vitest, Playwright e2e.

## Global Constraints

- **No new abstraction layers.** Reuse `packages/agentbook-jurisdictions`'s existing per-country pack structure (`us/`, `ca/`, `au/`, `uk/`) for every fix. Do not build a generic "N-country plugin framework" — only us/ca/au/uk exist or are planned; do not scaffold for hypothetical future countries.
- **No speculative aggregator abstraction.** The AU bank-sync integration (PR AU-1) targets one CDR-accredited aggregator with a minimum-viable read-only transaction-sync flow, mirroring the existing Plaid integration's shape (`agentbook-plaid.ts`) — not a multi-aggregator plugin system.
- **Reuse before rewrite.** Every US/CA money-correctness fix (sales tax, state withholding, provincial brackets, mileage rate) wires an already-implemented, already-tested engine into its call site. Do not re-derive tax logic that already exists in `packages/agentbook-jurisdictions`.
- **Never mutate the shared main checkout.** All work happens in dedicated worktrees per [[feedback_never_mutate_main_checkout]]. New worktrees need `npm install` (no `--workspaces=false`) before symlinks resolve.
- **Never push directly to `main`.** Every PR — including one-line mechanical fixes — goes through a real PR, full CI (no `--admin` merges), then merge.
- **Production DB migrations, third-party account creation (e.g. signing up for a CDR aggregator sandbox/production account), pricing/currency changes that touch live Stripe billing, and any customer-facing communication are each their own explicit, separately-confirmed step** — do not bundle them into a PR merge silently. This is a continuation of the standing rule from the prior roadmap, not a new one.
- **CI-coverage work wires existing suites into `ci.yml`; it does not rewrite test suites** unless a wired-in test is found genuinely broken (in which case fix the test, don't skip it).
- **Vulnerability triage patches via version bumps / `npm audit fix`,** not vendoring or forking dependencies.
- **Avoid over-engineering:** each PR's acceptance criteria is scoped to close the specific audited gap. Do not use a PR as an opportunity to refactor adjacent, unaudited code.
- **Every PR follows the established SDD process:** worktree → per-PR implementation plan (writing-plans skill) → SDD execution (implementer + reviewer per task) → per-task review → final whole-branch review on the most capable available model → CI → merge (never `--admin`) → build + deploy → live verification.

## Severity Taxonomy (used by every Gate task)

| Severity | Definition | Blocks phase advancement? |
|---|---|---|
| **Critical** | Wrong money/tax output, broken core workflow, or a structural absence of a table-stakes feature (e.g. no bank sync at all) | Yes |
| **High** | Materially incomplete or misleading output in a real user-facing flow, but narrower blast radius than Critical (e.g. missing FUTA computation, T4A slip generation absent) | Yes |
| **Medium** | A real competitiveness or quality gap that isn't money-wrong — inconsistent UX, an honest-but-incomplete feature, a scope limitation not disclosed to the user | Yes |
| **Low** | Cosmetic, nice-to-have, or a documented/accepted scope boundary | No — log it, don't loop back for it |

"Medium above" in the Gate protocol below means Critical, High, or Medium. A phase is not complete while any Critical/High/Medium finding remains open.

## Phase Gate Protocol (identical shape for all three Gate tasks)

Every Gate task (`PR US-GATE`, `PR CA-GATE`, `PR AU-GATE`) runs the same four-step protocol:

1. **Fidelity re-audit:** dispatch a fresh, evidence-based re-read of every file this phase's PRs touched (via `git show origin/main:<path>`, not the local checkout) to confirm each PR's claimed fix is actually live in `origin/main` and actually closes the gap it was scoped to close — not just "PR merged," but "the specific bug is gone, verified by reading the current code."
2. **Competitive refresh:** dispatch fresh research on the current (re-verify, don't assume last week's findings are still true) top-10 accounting SaaS players in this specific market for the target persona, refreshing pricing, feature set, and AI-capability claims where the prior audit's research is more than a few weeks stale.
3. **SWOT synthesis:** produce a written SWOT (Strengths / Weaknesses / Opportunities / Threats) for AgentBook in this market against that competitive set, plus an explicit severity-tagged gap list (using the taxonomy above) and a direct verdict: does AgentBook now reach top-10 parity in this market for the target persona, yes or no, and why.
4. **Loop-back decision:**
   - If the gap list contains **zero** Critical/High/Medium findings → the phase is **COMPLETE**. Record the SWOT and verdict, advance to the next phase.
   - If the gap list contains **any** Critical/High/Medium finding → the phase is **NOT COMPLETE**. For each finding, add a new remediation PR to the end of this phase's task list (scoped tightly to that finding — no scope creep), execute it via the normal SDD process, then re-run the Gate task from Step 1. Repeat until the gap list is empty.

A phase's Gate task is the only task in this roadmap that is explicitly designed to repeat.

---

# Phase 1 — United States Launch Ready

**Why first:** the US is the market with the most existing infrastructure and the smallest gap to close; closing it first also lands market-agnostic foundational fixes (CI coverage, vulnerability triage, the PWA sign-in bug below) that benefit the CA and AU phases without needing to repeat them.

### PR US-0 (Critical, do first): Fix PWA mobile Google Sign-In infinite loop

**Reported by the user directly** (not from the prior audit): on mobile, when AgentBook is installed as a PWA (added to home screen, running in standalone display mode), signing in with Google gets stuck in an infinite loop — the user completes Google's consent screen but is bounced back to the sign-in screen repeatedly instead of landing in the app.

**Root-cause evidence found by reading the current code (`origin/main`):**
1. `apps/web-next/public/sw.js:15-18` — `PRECACHE_URLS` includes `'/agentbook'`, which the service worker fetches and caches at **install time** — i.e., before the user has ever authenticated. Since `/agentbook` requires the `naap_auth_token` cookie (`middleware.ts:186-192`), the precache step almost always captures the **unauthenticated redirect-to-login response**, not the real dashboard, and stores it under the `/agentbook` cache key.
2. `apps/web-next/public/sw.js:60-64` (`networkFirstWithCache`, used for every `mode: 'navigate'` request) falls back to whatever is cached under that request's URL on any network hiccup — which, combined with #1, means a flaky connection right after the OAuth round-trip (very common on mobile switching between the app and the system browser) serves the **stale pre-auth login redirect** instead of the freshly authenticated `/agentbook` page, stranding the user on what looks like a login-required screen.
3. `apps/web-next/src/contexts/auth-context.tsx:244-264` (`loginWithOAuth`) performs a plain top-level `window.location.href = url` redirect with no standalone-mode awareness at all. On iOS, a standalone (home-screen-installed) PWA's cross-origin top-level navigation to `accounts.google.com` is generally handed off to the system browser, whose cookie storage is isolated from the installed PWA's own storage container. The callback route (`apps/web-next/src/app/api/v1/auth/callback/[provider]/route.ts:47-56`) sets `naap_auth_token` and redirects to `/agentbook` — which can succeed in the system browser context while the originally-open standalone PWA window never observes that cookie, so returning to the home-screen app icon still shows the sign-in screen no matter how many times Google's consent screen is completed.

**Files:**
- Modify: `apps/web-next/public/sw.js` — remove `/agentbook` (or any auth-gated route) from `PRECACHE_URLS`; change the navigation cache-fallback behavior so a `mode: 'navigate'` fetch never serves a stale cached response for `/login` or `/agentbook` when the network responds at all (network-only for these two paths is acceptable — they're the auth-sensitive hinge of the whole app, not something that benefits from an offline cache fallback), and never `cache.put()` a navigation response whose final `response.url` doesn't match the requested path (this also stops the OAuth callback URL's one-time response from ever being cached under a general navigation key).
- Modify: `apps/web-next/src/contexts/auth-context.tsx` (`loginWithOAuth`) — detect standalone/installed-PWA display mode (`window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true`).
- Modify: `apps/web-next/src/app/api/v1/auth/callback/[provider]/route.ts` — when the callback completes successfully, if there's a signal the request is running outside the installed PWA context (can't be fully eliminated — iOS's Safari/standalone storage split is an OS-level restriction, not something app code can override), render an explicit "You're signed in — return to the app" interstitial instead of a silent redirect, so a user stuck in the system-browser context gets a working, honest way back into a real session rather than an invisible bounce.

**Explicitly not doing:** no popup-window/`postMessage` OAuth bridge — that's a heavier architecture change than this bug needs, and iOS's storage isolation would defeat it in the same way. This fix closes the deterministic, verifiable code-level bug (stale precache + wrong cache-fallback) outright, and turns the harder platform-level part (storage isolation) from an invisible infinite loop into a visible, recoverable one-more-step.

**Acceptance criteria:** on a real iOS and Android device with AgentBook installed as a PWA, signing in with Google completes and lands the user in a real authenticated `/agentbook` session without looping; regular (non-PWA, browser-tab) sign-in behavior is unchanged; a fresh install's very first `/agentbook` visit (pre-auth) is never served from a stale cache entry.

### PR US-1: Wire US sales tax into invoicing

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-invoice-tax.ts` (currently hardcodes `return ZERO_TAX` for US at ~line 120, bypassing the real `us/sales-tax.ts` engine)
- Modify: `plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx:157` (`showTaxField` currently only true for `au`/`ca` — add `us`)
- Reference (read-only, already correct): `packages/agentbook-jurisdictions/src/us/sales-tax.ts`

**Acceptance criteria:** creating a US invoice with a nexus state selected applies that state's real sales tax rate from the existing 15-state engine and posts it to the correct ledger account, matching the pattern already proven for CA GST/HST/QST and AU GST (PR-6 of the prior roadmap). Non-nexus states / no rate configured falls back to $0 explicitly, not silently.

### PR US-2: US payroll state income tax withholding

**Files:**
- Modify: `apps/web-next/src/lib/payroll-engine.ts:67` (`stateTaxCents = 0` hardcoded)

**Acceptance criteria:** payroll calculations withhold a real state income-tax amount for states that have one, using per-state rate data (flat-rate states can use a simple table; progressive states get their real brackets — scope to the states covered by existing US tax-bracket data first, extend only as far as audit evidence requires. States with no income tax (TX, FL, WA, etc.) correctly compute $0, and that $0 is intentional, not a fallback.

### PR US-3: Form 940 (FUTA) computation + filable PDF exports for 940/941/W-2

**Files:**
- Modify: wherever 941 quarterly remittance is currently computed (payroll/tax-forms module) — add FUTA computation using the standard federal FUTA rate/wage-base rules
- Modify: the "Download" action for 941/940/W-2 currently opening raw JSON — render an actual IRS-form-shaped PDF

**Acceptance criteria:** Form 940 produces a real computed FUTA liability figure (not a label-only placeholder); downloading any of 940/941/W-2 produces a document a user could plausibly hand to an accountant, not a JSON blob.

### PR US-4: Married-filing-jointly federal bracket table

**Files:**
- Modify: wherever the single-filer-only federal bracket table lives (tax-estimate engine)

**Acceptance criteria:** a user can select filing status (single / married filing jointly) and get the correct bracket table applied; single-filer behavior is unchanged when that status is selected.

### PR US-5: Reconnect 1099-NEC contractor-reporting logic

**Files:**
- Investigate: `packages/agentbook-framework/src/skills/contractor-reporting/handler.ts` (real logic, zero live callers)
- Modify: wire this logic into a reachable route/skill rather than rebuilding it — the goal is making existing correct logic reachable, not re-authoring it

**Acceptance criteria:** a US tenant can generate a 1099-NEC threshold report for a contractor from a real, reachable UI or chat-skill path. If, on inspection, `agentbook-framework`'s logic doesn't cleanly fit the current plugin architecture, the fallback is a thin new wrapper that calls into it — not a rewrite.

### PR US-6 (Cross-cutting, foundational): Wire AgentBook backend tests into CI

**Files:**
- Modify: `.github/workflows/ci.yml` — add a job (or extend `plugin-tests`) that runs `vitest run` for `plugins/agentbook-core/backend`, `plugins/agentbook-invoice/backend`, `plugins/agentbook-expense/backend`, `plugins/agentbook-tax/backend`, `plugins/agentbook-startup/backend`, and `packages/agentbook-jurisdictions`

**Acceptance criteria:** a PR that breaks any AgentBook backend test fails CI. This is scoped to *wiring in* the ~41 existing backend test files — not writing new tests, unless a wired-in suite reveals a genuinely broken test, in which case fix only that test.

### PR US-7 (Cross-cutting, foundational): Triage the 102 dependency vulnerabilities

**Files:** `package.json`/lockfiles across the monorepo (targeted version bumps per flagged package)

**Acceptance criteria:** the 4 Critical and 75 High findings from `npm audit` are resolved via version bumps (or, where a bump isn't available, documented as an accepted risk with a reason — not silently ignored). The Audit CI check stops being "known to fail" noise.

### PR US-8 (Cross-cutting, foundational): Propagate PR-10's auth hardening to sibling plugin backends

**Files:**
- Modify: `plugins/agentbook-startup/backend/src/server.ts:33`, `plugins/agentbook-invoice/backend/src/server.ts:43`, `plugins/agentbook-expense/backend/src/server.ts:45`, `plugins/agentbook-tax/backend/src/server.ts:184` — apply the same `NODE_ENV`-conditional `publicRoutes`/`tenantMiddleware` pattern already live in `agentbook-core`

**Acceptance criteria:** all 5 plugin backends share the identical auth-hardening posture in production; behavior in dev/self-hosted mode is unchanged.

### PR US-9 (Critical — carries over from the prior roadmap as task #134): Add-on subscribe/view/cancel UI

**Files:**
- Modify: `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` (`BillingTab()`, ~lines 740-806) — replace "contact support to cancel" with a real list of active add-ons (subscribe/view/cancel)
- Modify: `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/route.ts` — extend `GET` to list all active add-ons, not just single-code lookup
- Fix: `apps/web-next/src/app/(dashboard)/personal/page.tsx:363-390` (`upgradeToPersonalInsights()`) — supply the `paymentMethodId` its own Zod schema requires, or route through a proper checkout flow

**Acceptance criteria:** a user can see every add-on they're subscribed to, subscribe to a new one, and cancel an existing one, entirely from the UI — no "contact support" text remains. This is the single highest-revenue-impact PR in the whole roadmap; do not descope it.

### PR US-GATE: Competitive Readiness Assessment — United States

Run the Phase Gate Protocol (above) against the top US players already researched (QuickBooks Solopreneur/Online, Xero, FreshBooks, Wave, Zoho Books, Sage, Bonsai, Bench, Pilot.com, Found/Lili/Novo), refreshing anything stale. Loop back per the protocol until clean.

#### US-GATE Report — Attempt 1 (2026-07-18)

**Step 1 — Fidelity re-audit (against `origin/main`, all 10 PRs merged):** US-0, US-3, US-5, US-6, US-7, US-8, US-9 all CONFIRMED CLOSED with no material gaps. US-1, US-2, and US-4 each have a real, verified gap (below) that survived the PR meant to close them.

**Step 2 — Competitive refresh:** Re-researched all 10 named US competitors (live pricing/feature/AI-move check, July 2026). Table-stakes for this persona in 2026: AI receipt OCR + auto-categorization, Plaid-equivalent bank sync, a chat/copilot layer over the ledger, basic 1099 + mileage handling, and real-time tax-estimate nudges — AgentBook already clears all of these. Genuine open differentiators identified: (a) truly autonomous confidence-scored close vs. every incumbent's "suggest, don't decide" posture (Pilot's "AI Accountant" is the sole exception, sold as a $99+/mo services add-on, not an integrated app); (b) a conversational channel (Telegram) as the *primary* surface rather than a bolted-on chat widget — no competitor in the set does this; (c) one subscription covering bookkeeping + sales tax + 1099s + estimates, vs. Pilot/Bench/QuickBooks/Sage's stacked-add-on pricing; (d) the persona-adjacent add-on marketplace (scholarship/career/housing) — no analog anywhere in the set. No competitor move surfaced that itself creates a new required PR.

**Step 3 — SWOT:**
- **Strengths:** full table-stakes parity (OCR, bank sync, chat AI, 1099/mileage, tax estimates) reached in a single subscription tier, unlike Pilot/Bench/Sage/QuickBooks' add-on-stacked pricing; Telegram-native conversational surface with no direct competitor analog; confidence-decayed memory/correction-learning architecture positions AgentBook ahead of the industry's current "suggest, don't decide" AI posture; student/startup add-on marketplace is a genuinely novel wedge with zero competitive overlap.
- **Weaknesses:** US sales-tax and payroll state-withholding engines only cover 15 of 50 states + DC, with the uncovered ~35 states silently returning $0 — indistinguishable from an intentional no-tax state, which is a real compliance-trust risk for the majority of US states. The federal tax-bracket table used for the (numerically larger) single-filer segment is quietly a year stale (2024 IRS figures mislabeled 2025) while the newer MFJ table is correctly sourced — an inverted-precision gap.
- **Opportunities:** the industry's own AI framing is still "assist, not decide" (even Intuit Assist and Xero's JAX); a product that can show its confidence and actually execute (not just draft) close work has real whitespace to claim before incumbents catch up. Sage's May 2026 "glass box" AI messaging signals incumbents themselves see AI-trust as an unresolved, nameable gap — an opening for a product that already tracks confidence per fact.
- **Threats:** Pilot's "AI Accountant" (Feb 2026) and "Meridian" (June 2026) show a well-funded competitor moving fastest toward the same "autonomous close" positioning AgentBook is aiming for; if AgentBook's own tax-accuracy foundation (bracket tables, per-state coverage) has visible gaps, that specific pitch is undermined by its own numbers being wrong for most users/states.

**Step 4 — Gap list (severity-tagged) and verdict:**

| # | Finding | Severity | Rationale |
|---|---|---|---|
| 1 | Sales tax (`agentbook-invoice-tax.ts`) and payroll state withholding (`payroll-engine.ts`) share one 15-state rate table; the other ~35 states + DC silently resolve to `$0`, identical in shape to an intentionally-zero state (e.g. TX/FL/WA). US-1's own acceptance criteria required "$0 explicitly, not silently" — this was not met. | **High** | Materially misleading output in a real, money-touching, user-facing flow (invoicing + payroll) for the majority of US states — not a cosmetic gap, but not a wrong *filed* liability either (self-reported estimate/preview context), so short of Critical. |
| 2 | `FEDERAL_BRACKETS_2025_SINGLE` (`packages/agentbook-jurisdictions/src/us/tax-brackets.ts`) is sourced from 2024 IRS thresholds mislabeled as 2025, while the newer `FEDERAL_BRACKETS_2025_MARRIED` table is correctly 2025 — the numerically larger single-filer segment gets the less-accurate estimate. | **High** | Wrong-money-output pattern, but confined to an *estimate* tool (not a filed return) with a modest per-bracket dollar drift — real, but bounded blast radius keeps it below Critical. |

Both findings are **High** severity → per the protocol, **Phase 1 is NOT COMPLETE**. Two remediation PRs are appended below; the Gate re-runs (Attempt 2) once both land.

### PR US-10 (High): Expand US per-state sales-tax + payroll-withholding coverage, and make missing-rate states explicit

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/us/sales-tax.ts` (`STATE_RATES`) — extend from 15 states to all 50 states + DC with real current combined state sales-tax rates (the 5 already-correct $0 no-sales-tax states — OR, NH, MT, DE, AK — stay as explicit `0` entries, not removed).
- Modify: `apps/web-next/src/lib/payroll-engine.ts` (`US_STATE_INCOME_TAX_RATES`) — same expansion for state income-tax withholding rates (flat-rate states get their real flat rate; the 9 no-income-tax states — AK, FL, NV, NH, SD, TN, TX, WA, WY — stay explicit `0`; progressive-bracket states get a documented flat-equivalent approximation if a full bracket engine is out of scope, clearly commented as such).
- Modify: both call sites' consumers (invoice tax line item, payroll pay-stub breakdown) to distinguish, in the API response and UI, "no tax in this state" (real `0`) from "state not yet covered" (should not silently render as `$0` — render an explicit "rate not configured for this state, please verify" notice instead) — this is the specific acceptance-criteria gap the fidelity audit found.

**Acceptance criteria:** every US state + DC has an explicit, correct entry in both tables (a real rate or a real, intentional `0`); no state can produce a bare `$0` through the "not found" fallback path — that path should be unreachable once every state has an explicit entry, and the response distinguishes intentional-zero from not-yet-covered in case any future state is added without a rate.

### PR US-11 (High): Fix the stale 2024-vs-2025 single-filer federal bracket table

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/us/tax-brackets.ts` (`FEDERAL_BRACKETS_2025_SINGLE`) — replace with the real 2025 IRS single-filer thresholds ($11,925 / $48,475 / $103,350 / $197,300 / $250,525 / $626,350), sourced with the same rigor already used for `FEDERAL_BRACKETS_2025_MARRIED`.

**Acceptance criteria:** single-filer tax estimates use genuine 2025 IRS thresholds; MFJ behavior is unchanged; a regression test pins both tables' exact threshold values so this can't silently drift stale again.

#### US-GATE Report — Attempt 2 (2026-07-18)

**Step 1 — Fidelity re-audit** (against `origin/main` at `7a85b5e4`, both remediation PRs merged): both Attempt-1 findings independently re-verified via a fresh subagent reading real `git show origin/main:<path>` content (not a local worktree):
- **Finding 1 (sales-tax + payroll state coverage): CONFIRMED CLOSED.** `STATE_RATES` (`sales-tax.ts`) and `US_STATE_INCOME_TAX_RATES` (`payroll-engine.ts`) both now `export const` with exactly 51 entries each (verified programmatically); the frontend preview table matches value-for-value across all 51 codes with zero mismatches. The completeness tests were independently confirmed to now do a genuine `Object.keys()` membership check (not just "output is a number") per the whole-branch review's fix.
- **Finding 2 (stale single-filer bracket table): CONFIRMED CLOSED.** `FEDERAL_BRACKETS_2025_SINGLE` holds the exact required 2025 IRS cents thresholds; `FEDERAL_BRACKETS_2025_MARRIED` unchanged and still exactly 2x single for every bracket except the correctly-undoubled top bracket.
- **Regression check**: fresh detached worktree off `origin/main` (outside any pre-existing `.worktrees/`), full `packages/agentbook-jurisdictions` suite (254/254 pass) and the 3 directly-affected `apps/web-next` test files (34/34 pass). No regressions.
- **One new Low-severity item logged, not blocking**: `usTaxBrackets.getTaxBrackets(taxYear)` ignores its `taxYear` argument (pre-existing `// TODO: year-versioned lookup`, predates both remediation PRs) and doesn't branch on filing status the way `calculateTax` correctly does via `bracketsFor`. Not reachable from any production path today (the app calls `calculateTax`, not `getTaxBrackets`, for real tax estimates) — logged as a documented, accepted scope boundary per the severity taxonomy (Low: doesn't block advancement), worth a follow-up ticket if `getTaxBrackets` ever gains a real caller.

**Step 2 — Competitive refresh**: not re-run for Attempt 2 — the competitive landscape doesn't change day-to-day and Attempt 1's research (same day) already established the current top-10 US set's positioning; no new competitor move surfaced between Attempt 1 and Attempt 2 that would change the SWOT below.

**Step 3 — SWOT**: unchanged from Attempt 1's synthesis (see above), with the two Weaknesses items ("15/50-state tax coverage" and "stale single-filer bracket table") now resolved and removed from the active gap list.

**Step 4 — Gap list and verdict**: zero Critical/High/Medium findings remain open. **Phase 1 (United States) is COMPLETE.**

One Low-severity item is logged for optional future follow-up (see above) but does not block advancement per the severity taxonomy. Proceeding to Phase 2 (Canada).

---

# Phase 2 — Canada Launch Ready

**Precondition:** Phase 1 gate is clean.

### PR CA-1 (Critical): Fix provincial tax bracket fallback

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-forms.ts:256-350` — `PROVINCIAL_BRACKETS[province] || PROVINCIAL_BRACKETS['ON']` currently defaults 7 provinces + 3 territories to Ontario's rate

**Acceptance criteria:** every Canadian province and territory has its own real 2025 bracket table feeding the live T1 auto-populate route (`GET /api/v1/agentbook-tax/tax-filing/[year]`); no province silently inherits another's rate.

### PR CA-2 (High): Quebec payroll — QPP/QPIP instead of CPP/EI

**Files:**
- Modify: payroll-engine's CPP/EI computation — branch on province, applying QPP (Quebec Pension Plan) and QPIP (Quebec Parental Insurance Plan) rates for Quebec employees instead of federal CPP/EI

**Acceptance criteria:** a Quebec employee's payroll deduction uses real QPP/QPIP rates; every other province's CPP/EI computation is unchanged.

### PR CA-3 (High): T4 real CRA box numbers + T4A slip generation

**Files:**
- Modify: T4 aggregation logic — map to actual CRA box numbers (14, 16, 18, 22, etc.) instead of generic keys
- Add: T4A slip generation (currently only an eligibility report exists)

**Acceptance criteria:** a generated T4 uses real CRA box numbers; a T4A slip can actually be generated for eligible contractor payments, not just flagged as eligible.

### PR CA-4 (Medium): CAD core-plan pricing

**Files:**
- Modify: `packages/agentbook-pricing/src/index.ts` (`CORE_PLANS` — currently USD-only, no region field)
- Modify: Stripe product/price wiring for Free/Pro/Business to support a CAD variant, matching the pattern already proven for the 3 consumer add-ons

**Acceptance criteria:** a CA tenant sees and is billed in CAD for Free/Pro/Business, matching the existing CAD add-on pricing pattern. **This PR touches live Stripe billing — the Stripe-side product/price creation is its own explicit, separately-confirmed step before this PR merges the code that reads it.**

### PR CA-5 (Medium): Fix the reachable US-default chart-of-accounts duplicate

**Files:**
- Modify: `agentbook/seed-personas.ts:70,281,464` — stop calling `http://localhost:4050` directly; go through the Next.js route (or, if the Express duplicate in `plugins/agentbook-core/backend/src/server.ts:1915` is truly dead in production, delete it rather than leaving it reachable from tooling)

**Acceptance criteria:** regenerating the "Maya (CA consultant)" demo persona locally produces a real T2125 chart of accounts, not a US Schedule-C one.

### PR CA-GATE: Competitive Readiness Assessment — Canada

Run the Phase Gate Protocol against the top CA players already researched (QuickBooks Online Canada, Xero Canada, Wave, FreshBooks, Wagepoint, TurboTax Self-Employed CA / Wealthsimple Tax, AI-native CA entrants), refreshing anything stale. Loop back per the protocol until clean.

---

# Phase 3 — Australia Launch Ready

**Precondition:** Phase 2 gate is clean.

### PR AU-1 (Critical, largest PR in this phase): CDR-accredited bank-sync integration

**Files:**
- New: an AU bank-sync module mirroring `apps/web-next/src/lib/agentbook-plaid.ts`'s shape, built against a CDR-accredited aggregator (Basiq, Frollo, or Adatree — pick one; do not build a multi-aggregator abstraction)
- New: link/exchange/sync API routes mirroring the existing Plaid route shape
- Modify: `apps/web-next/src/lib/agentbook-plaid.ts:77` / `agentbook-personal-plaid.ts:64` — no change to Plaid's own `country_codes: [CountryCode.Us, CountryCode.Ca]`; AU routes through the new module entirely, not through Plaid

**Acceptance criteria:** an AU tenant can connect a real bank account and sync transactions through a CDR-accredited aggregator, at minimum-viable scope (read-only transaction sync, matching what Plaid provides for US/CA today — reconciliation/categorization already works once transactions land). **Signing up for the aggregator's sandbox/production account is a separate, explicitly-confirmed step before this PR's code can be live-verified against a real account** — this is account creation on a third-party service and requires the user's own action per the standing action-category rules.

### PR AU-2 (Critical): Fix the AU mileage rate

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-expense/mileage/route.ts:95` — currently coerces every AU tenant to `'us'`; wire in the existing, correct `packages/agentbook-jurisdictions/src/au/mileage-rate.ts` (88¢/km ATO rate)

**Acceptance criteria:** an AU tenant's mileage deduction uses the real 88¢/km ATO rate; US/CA mileage behavior is unchanged.

### PR AU-3 (Critical): Fix the cashflow-scenario AU tax bug

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts:54-63` — `calcTotalTax()` currently computes AU self-employment tax as literal $0 and applies US federal brackets to AU income; `fmt()` hardcodes `Intl.NumberFormat('en-US', {currency:'USD'})`

**Acceptance criteria:** the cashflow/what-if scenario tool computes real AU self-employment tax (Medicare Levy + ATO brackets, reusing the already-correct engine from `tax/estimate`) and formats currency using the tenant's actual configured currency, not a hardcoded USD locale.

### PR AU-4 (High): `taxEntityType`-aware tax calculation

**Files:**
- Modify: the tax-estimate calculation to branch on `taxEntityType` (pty_ltd/trust/sole_trader) — currently the field is selectable in the UI but ignored by the math, so a Pty Ltd company gets individual progressive-bracket math instead of a flat corporate rate

**Acceptance criteria:** selecting `pty_ltd` applies the flat AU corporate tax rate; `sole_trader` keeps the existing individual progressive-bracket path unchanged.

### PR AU-5 (Medium): AUD core-plan pricing

**Files:** same shape as PR CA-4, for AUD instead of CAD

**Acceptance criteria:** an AU tenant sees and is billed in AUD for Free/Pro/Business. **Same standing rule as PR CA-4 — the Stripe-side product/price creation is its own explicit, separately-confirmed step.**

### PR AU-6 (Medium): Sweep remaining AU-specific jurisdiction-fallback sites

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-expense/per-diem/route.ts` (currently typed `'us' | 'ca'` only)
- Modify: `apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts`, `agentbook-digest-tips.ts` (wrong tax-deadline reminders for AU)
- Modify: Telegram webhook / `agentbook-bot-agent.ts` (SE-tax figures, "CRA rate"/"IRS rate" labels, form names — binary today)
- Modify: `agentbook-tax-pdf.ts`, `agentbook-tax-package.ts` (exported PDF/report labels wrong for AU)

**Acceptance criteria:** every one of these four call sites correctly branches for `au` tenants (real ATO figures/labels/deadlines), not just `us`/`ca`. This is the AU installment of the systemic anti-pattern already fixed piecemeal for other paths in the prior roadmap (PR-1, PR-8) — treat it as one sweep, not four separate PRs, since the same audit pass covers all four sites.

### PR AU-7 (Medium): Jurisdiction-aware chat/MCP bank-connect redirect

**Files:**
- Modify: the "connect my bank" chat/MCP redirect (PR-11 of the prior roadmap) to route AU tenants to the new PR AU-1 flow instead of the Plaid flow it currently points at unconditionally

**Acceptance criteria:** an AU tenant asking the chatbot/MCP to connect a bank account gets routed to a flow that can actually work for them.

### PR AU-8 (Medium): Disclose the Single Touch Payroll scope limitation

**Files:**
- Modify: AU payroll UI copy — the calculator/records-only scope (no STP lodgment) is currently silent; add explicit, honest scope-limitation copy matching the pattern already used for the CA international-student honest-fallback content

**Acceptance criteria:** an AU employer using payroll sees a clear statement that STP real-time reporting isn't handled yet, rather than discovering it's missing on their own.

### PR AU-GATE: Competitive Readiness Assessment — Australia

Run the Phase Gate Protocol against the top AU players already researched (Xero, MYOB, QuickBooks Online AU, Reckon One, Rounded, Hnry, Thriday/Parpera), refreshing anything stale — pay particular attention to whether the PR AU-1 bank-sync integration genuinely closes the gap the prior audit flagged as the clearest hard blocker of all three markets. Loop back per the protocol until clean.

---

## Final Sign-off

Once all three Gate tasks report a clean (zero Critical/High/Medium) result in sequence, AgentBook is launch-ready for US, CA, and AU per this roadmap's definition. Produce a final one-page summary (reusing the existing HTML-artifact reporting pattern) stating, per market: the SWOT, the verdict, and any Low-severity items intentionally deferred — so "launch ready" is a documented conclusion, not an assumption.
