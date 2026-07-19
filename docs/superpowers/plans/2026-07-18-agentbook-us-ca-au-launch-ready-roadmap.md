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

#### CA-GATE Report — Attempt 1 (2026-07-18)

**Step 1 — Fidelity re-audit (against `origin/main`, all 5 PRs merged):** CA-1, CA-2, CA-3, and CA-5 all CONFIRMED CLOSED end-to-end (bracket tables, Quebec QPP/QPIP payroll math, real T4 box numbers + working T4A PDF generation, and the CA chart-of-accounts fix all independently re-verified by reading `origin/main`, not the PR descriptions). CA-4's code is also CONFIRMED CLOSED — region genuinely threads through pricing, billing routes, and `packages/billing/src/plans.ts` — but the audit confirmed two **production-activation steps intentionally deferred by design** are still outstanding: no live Stripe CAD Product/Price rows exist yet, and the `BillPlan.region` schema migration has not been run against production. This is not a code defect (the PR's own scope, and this roadmap's Global Constraints, explicitly required these as separate, user-confirmed steps) — but it means **a CA tenant cannot yet actually subscribe/be billed in CAD** until both steps are actioned. One pre-existing, out-of-scope Low-severity item surfaced: `tax-forms.ts`'s `CA_T2125_2025` template labels one field "Line 8520" while `ca/chart-of-accounts.ts`'s matching account uses "Line 8521" — a cosmetic T2125 line-number mismatch between two representations, unrelated to any of CA-1 through CA-5's scope.

**Step 2 — Competitive refresh:** Re-researched all named CA competitors plus a fresh scan for AI-native entrants (live pricing/feature/AI-move check, mid-2026). Table-stakes for this persona in the Canadian market: cloud bank-feed reconciliation, GST/HST/PST/QST auto-applied by province, mobile receipt capture, and (increasingly) some form of AI categorization — AgentBook already clears all of these. Notable findings: Xero has **no native Canadian payroll** at all (depends on a third-party Wagepoint integration, deepened July 2026) and Wave's payroll **excludes Quebec entirely** — only QuickBooks Online Canada matches AgentBook's full 13-province/territory coverage including Quebec's QPP/QPIP distinction. Xero's JAX (free-to-all-subscribers agentic assistant, OpenAI-backed) and Intuit's "Business Tax AI" deduction-finder are the two most credible AI-capability moves since the US-GATE research; a new, well-funded entrant (**Synthetic**, founded by Bench Accounting's former CEO, Khosla-backed) is the clearest emerging threat but is currently US-only and vertical-narrow (SaaS startups), with no Canadian tax-form support found.

**Step 3 — SWOT:**
- **Strengths:** the only product besides QuickBooks Online Canada with genuine, native 13-province/territory tax coverage including Quebec's distinct QPP/QPIP payroll math and real T4/T4A generation — a bar Xero and Wave both fail natively; one subscription bundling bookkeeping + full CA payroll + tax filing, vs. Xero's dependency on a bolted-on Wagepoint integration; Telegram-native conversational surface and confidence-scored autonomous execution remain differentiated against every named competitor's dashboard-first, "suggest then approve" AI posture; the student/startup add-on marketplace has no CA-market analog.
- **Weaknesses:** CAD billing is not yet live in production (Stripe pricing + schema migration pending, by design) — a CA tenant technically cannot subscribe/pay in CAD today, only once those two explicitly-confirmed steps are actioned. AgentBook's existing proactive-alerts (expense review/receipts/reconciliation/spending-spike detection) and payment-reminders cron cover meaningful ground but are narrower in scope than Xero JAX's specific AP bill-screening + AR payment-timing prediction, or Intuit's dollar-impact-ranked deduction finder — a real but general (not CA-specific) capability gap.
- **Opportunities:** Xero's own admission that Canadian payroll needs a third-party bolt-on is a direct wedge for a "one native subscription" pitch; Wave's Quebec exclusion is a concrete, nameable gap AgentBook can market against directly for Quebec-based freelancers/consultants, a segment incumbents are visibly not serving well.
- **Threats:** Synthetic's Bench-pedigreed, well-funded "fully autonomous, no-human-bookkeeper" positioning is the clearest structural threat to AgentBook's own autonomous-execution pitch if it expands beyond US SaaS-vertical and into general Canadian SMB/freelancer territory — worth monitoring for expansion signals, not yet an active competitor in this segment; Wagepoint's new self-serve/timesheet products under an ex-Xero CEO suggest payroll specialists are moving toward broader AI-adjacent tooling that could narrow AgentBook's "only native Quebec payroll" advantage over time.

**Step 4 — Gap list (severity-tagged) and verdict:**

| # | Finding | Severity | Rationale |
|---|---|---|---|
| 1 | CA core-plan CAD billing is code-complete but not production-active: no live Stripe CAD Product/Price rows exist, and the `BillPlan.region` migration hasn't run against production. | **Not a code gap — outstanding production-activation action** | Explicitly scoped as a separate, user-confirmed step per this roadmap's Global Constraints and CA-4's own acceptance criteria; no remediation PR can close this (the code is already correct) — it requires the user's own explicit go-ahead to create live Stripe pricing and run the prod schema push. |
| 2 | `CA_T2125_2025`'s "advertising" field is labeled "Line 8520" while `ca/chart-of-accounts.ts`'s matching account is labeled "Line 8521." | **Low** | Cosmetic line-number label mismatch between two internal representations of the same T2125 category, pre-existing and unrelated to CA-1 through CA-5's scope — logged, not blocking. |
| 3 | AgentBook's proactive-alerts/payment-reminders coverage is narrower than Xero JAX's AP bill-screening + AR payment-timing prediction and Intuit's ranked deduction-finder. | **Not CA-specific** | This is a general product capability gap versus a competitive move already visible in the US market at the time of the US-GATE (which did not flag it as blocking); introducing it as a CA-market-blocking finding here would be inconsistent with that precedent and risks scope creep beyond this roadmap's Canada-specific mandate. Named in the SWOT as a Weakness/Opportunity for future roadmap consideration, not gated on here. |

Zero Critical/High/Medium code-level findings survive → **Phase 2 is COMPLETE.** One Low-severity item is logged (not blocking). The CAD-billing production-activation gap is a real launch consideration, but it is — by this roadmap's own explicit design — the user's action to take, not a code remediation; it is called out clearly here rather than silently marked done. Advancing to Phase 3 (Australia).

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

# Phase 4 — Cross-Surface Parity Remediation

**Why this phase exists:** after AU-2 through AU-8 shipped, a three-agent audit (web dashboard UI, Telegram/MCP chat, PWA path) was run against every CA/AU capability this roadmap and its predecessor ("Launch-gap") shipped, checking whether each is actually reachable and correct from all three surfaces — not just "the API route works." The audit found real gaps, including one that predates this whole roadmap and isn't CA/AU-specific in cause: **`tax/estimate/route.ts` (the shared route behind both the web Tax Dashboard's headline number and the chat "estimate my taxes" skill) computes CA tax as federal-bracket-only — `caTaxBrackets.calculateTax()` never accepts or applies a province argument at all, despite the route already fetching `tenantConfig.region`.** Every Canadian tenant, on every surface, has been seeing an estimate that omits their entire provincial tax component. This was not caught by CA-1 (which fixed the separate T1-form auto-populate route's provincial fallback) or by CA-GATE (which audited CA-1 through CA-5's own claimed scope, not this adjacent shared route) — it surfaces only from this cross-surface check.

**Architecture:** Same PR-cycle discipline as Phases 1-3 — worktree → per-PR plan (writing-plans) → SDD execution (implementer + reviewer) → whole-branch review → CI → merge. PRs are grouped by root cause (one fix, many call sites) rather than by market, since several findings are the same bug class recurring across CA and AU.

## Severity-tagged findings

| # | Finding | Surface(s) | Severity |
|---|---|---|---|
| 1 | `tax/estimate/route.ts`'s CA path computes federal tax only — `caTaxBrackets` never takes a province argument, so every CA tenant's "estimated tax" (web Tax Dashboard headline number + chat `tax-estimate` skill) omits provincial tax entirely. | Web + Chat | **High** |
| 2 | Chat's `simulate-scenario` skill ("what if I earn/spend X more") computes tax impact via `deriveEffectiveRate(taxEstimate) \|\| 0.25` — a flat average-rate approximation — instead of calling the real bracket engine the way the already-fixed web `cashflow/scenario` route does. Imprecise for any progressive-bracket jurisdiction, most visibly wrong for AU where marginal rates swing from 0% to 45%. | Chat | **High** |
| 3 | `WhatIf.tsx` (the web cashflow-scenario UI) hardcodes `$` + `en-US` formatting — an AU tenant's real, AU-correct tax figures (after AU-3's backend fix) are displayed with a bare `$` and USD grouping, not AUD. | Web UI | **Medium** |
| 4 | `TaxPackage.tsx`'s `jurisdiction` type is `'us' \| 'ca'` only; an AU tax-package's totals fall back to USD formatting, and no AU form-name label is shown anywhere on the page (the correct "ATO Individual Tax Return" label only exists inside the generated PDF, per AU-6). | Web UI | **Medium** |
| 5 | `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx` hardcodes `${'$'}${price.toFixed(0)}` — CAD/AUD core-plan prices (CA-4/AU-5) render with a USD-looking `$` in the plan-picker UI that actually gates checkout, unlike the currency-correct `BillingTab`/`SubscribeModal`. | Web UI | **Medium** |
| 6 | The web "Connect bank" button (`personal/page.tsx`) has zero AU-awareness — it unconditionally calls Plaid and surfaces a generic opaque failure for AU tenants, even though the chat path (AU-7) already gives an honest, specific decline message. | Web UI | **Medium** |
| 7 | Chat has no Single Touch Payroll disclosure — `run-payroll`/`payroll-status` skills never read jurisdiction or mention STP, even though the web Payroll page (AU-8) now does. An AU employer running payroll via Telegram gets no disclosure at all. | Chat | **Medium** |
| 8 | Chat has no tax-deadline countdown for any jurisdiction — "when is my tax due" returns a static generic reply; `au/calendar-deadlines.ts` (already wired into the web digest via AU-6) is never imported by any chat/bot surface. | Chat | **Medium** |
| 9 | Quebec's QPP/QPIP/QC-EI (CA-2) are computed correctly but collapsed into one generic `ficaCents` figure everywhere they're displayed — web pay stubs, year-end tab, and the chat `run-payroll` skill (which is itself only a gross-pay preview stub with no withholding math or jurisdiction awareness at all). | Web + Chat | **Medium** |
| 10 | Service worker's `/api/v1/agentbook` cache rule matches by prefix, not exact namespace — it now silently sweeps in compute-on-read GETs (`tax/estimate`) and binary PDF/CSV downloads (T4/T4A/tax-package/mileage-export) added since the rule was written for the original expense/invoice namespace. No TTL exists, so an offline/flaky-network session can serve a stale tax estimate or an outdated regenerated document until the cache version is next bumped. | PWA | **Medium** |
| 11 | `Mileage.tsx`'s rate is only shown per-row after saving (no upfront preview like `PerDiem.tsx` has); its `jurisdiction` type omits `'au'`; its CSV export button is labeled "Schedule C / T2125 format" regardless of tenant jurisdiction. `PerDiem.tsx` shows a hardcoded US-city preview table and only declines for AU/CA reactively, after a failed submit. `Tax Dashboard`'s Pty Ltd (AU-4) tax figure has no entity-type explanation shown — the number changes but nothing tells the user why, and the breakdown labels ("SE Tax / CPP") are US/CA-centric even for an AU tenant. | Web UI | **Low** |
| 12 | Mileage has no offline-queue entry (`replayExpenseQueue`/`replayReceiptQueue`'s sibling would be a `replayMileageQueue` that doesn't exist) — currently unreachable in practice since no PWA-installed page writes mileage directly, but latent for whenever one does. `/app/page.tsx` (the PWA install shortcut's home) hardcodes `en-US` currency grouping. | PWA | **Low** |

**Not planned as remediation (explicitly out of scope, noted for completeness):** no chat skill exists at all for T4/T4A slip generation, core-plan pricing/upgrade, or chart-of-accounts read-back, for any jurisdiction — these are missing capabilities, not jurisdiction-specific regressions, and adding net-new chat skills is a larger product decision than a parity fix. Logged here so "missing" isn't confused with "silently broken."

## Remediation PRs

### PR PARITY-1 (High): Fix the shared tax-estimate route's CA federal-only bug
**Files:** `packages/agentbook-jurisdictions/src/ca/tax-brackets.ts` (`caTaxBrackets.calculateTax` — widen to accept and apply a province argument, reusing the real `PROVINCIAL_BRACKETS`/`PROVINCIAL_TAX` data already correct in `plugins/agentbook-tax/backend/src/tax-forms.ts` rather than re-deriving it); `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` (thread the already-fetched `region` into the CA bracket call it currently discards).
**Acceptance criteria:** a CA tenant's `tax/estimate` response includes their real province's provincial tax in `totalTaxCents`, on both the web Tax Dashboard and the chat `tax-estimate` skill (same route, so one fix closes both). US/AU/UK behavior unchanged. A regression test pins at least 3 provinces' combined federal+provincial figures against hand-computed values.

### PR PARITY-2 (High): Fix the chat scenario-simulator's tax-impact approximation
**Files:** `plugins/agentbook-core/backend/src/server.ts` (`simulate-scenario` handler, ~line 2462) — replace the flat `deriveEffectiveRate(...) || 0.25` approximation with a call into the same jurisdiction-aware bracket/SE-tax engine `cashflow/scenario/route.ts` already uses (via an HTTP call to that route, or a shared extracted helper — whichever avoids duplicating the engine a third time).
**Acceptance criteria:** the "what if" chat skill's tax-impact number matches the already-fixed `cashflow/scenario` web route's figure for the same inputs, across US/CA/AU. No fallback to a flat rate for any jurisdiction with a real bracket provider.

### PR PARITY-3 (Medium): Currency-display sweep — thread real tenant currency into every hardcoded-USD UI surface
**Files:** `plugins/agentbook-tax/frontend/src/pages/WhatIf.tsx`, `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx` (also widen its `jurisdiction` type to include `'au'`/`'uk'` and add the missing AU/CA/US form-name label), `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx`, `apps/web-next/src/app/(dashboard)/payroll/page.tsx` (`fmt$`), `apps/web-next/src/app/app/page.tsx` — all reuse the already-established `useTenantCurrency()`/`formatCurrencyCents` pattern already correctly used by `CashFlow.tsx` and `BillingTab`/`SubscribeModal`, not a new formatter.
**Acceptance criteria:** every listed surface displays AUD/CAD (not a bare `$`/en-US) for a tenant configured in that currency; a visual/snapshot check confirms the plan-picker (`PlanGrid.tsx`) specifically, since it's the one that gates a real checkout action.

### PR PARITY-4 (Medium): AU-aware web bank-connect button
**Files:** `apps/web-next/src/app/(dashboard)/personal/page.tsx` — read the already-fetched `jurisdiction` state before calling `handleStartBankConnect`; for AU, show the same honest message already shipped for chat (AU-7) instead of attempting the Plaid call and surfacing an opaque failure.
**Acceptance criteria:** an AU tenant sees the message before attempting to connect, not after a failed API call; US/CA behavior unchanged.

### PR PARITY-5 (Medium): Chat parity sweep — STP disclosure + tax-deadline countdown
**Files:** `plugins/agentbook-core/backend/src/server.ts` (`run-payroll`/`payroll-status` handlers — add the same AU STP disclosure text already shipped on the web Payroll page, gated the same way); the "when is my tax due"/daily-briefing handlers (`agent-brain.ts`, `server.ts`) — wire in `PACKS[jurisdiction].calendarDeadlines.getDeadlines(...)` (the same mechanism `agentbook-digest-tips.ts` already uses post-AU-6) instead of the static generic reply.
**Acceptance criteria:** an AU tenant asking the bot to run payroll sees the STP disclosure; asking "when is my tax due" gets a real, jurisdiction-correct next-deadline answer instead of "what country/state are you in."

### PR PARITY-6 (Medium): Itemize Quebec QPP/QPIP + give chat payroll real withholding math
**Files:** `apps/web-next/src/app/(dashboard)/payroll/page.tsx` (pay-stub and year-end rows — break out the pension/EI/QPIP components `splitCaDeductions` already computes, instead of one combined figure); `plugins/agentbook-core/backend/src/server.ts` (`run-payroll` chat handler — call the real `payroll-engine.ts` withholding calculation instead of a gross-only stub, for every jurisdiction, not just CA).
**Acceptance criteria:** a Quebec employee's pay stub (web) shows QPP/QPIP/QC-EI as distinct lines; the chat `run-payroll` reply shows real net pay after real withholding, matching what the web Payroll page would compute for the same run.

### PR PARITY-7 (Medium): Scope the service-worker cache rule
**Files:** `apps/web-next/public/sw.js` — narrow the `/api/v1/agentbook` prefix match to an explicit allowlist (or add an explicit exclusion for compute-on-read GETs like `tax/estimate` and binary-download routes like the T4/T4A/tax-package/mileage-export endpoints), so these routes are always network-only, never served stale.
**Acceptance criteria:** `tax/estimate` and every binary-download route always hit the network when online; offline behavior for the routes this rule was actually written for (expenses/invoices/trial balance) is unchanged.

### PR PARITY-8 (Low): Type completeness + minor UX polish
**Files:** `plugins/agentbook-expense/frontend/src/pages/Mileage.tsx` (widen `jurisdiction` type to include `'au'`; add a rate preview before submission; make the CSV export label jurisdiction-aware instead of always "Schedule C / T2125"); `plugins/agentbook-expense/frontend/src/pages/PerDiem.tsx` (show the AU/CA decline message upfront based on tenant jurisdiction, not only after a failed submit; drop the hardcoded-US-city preview's implicit "this works for you" framing for non-US tenants); `plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx` (add a one-line entity-type explanation string next to the AU Pty Ltd tax figure).
**Acceptance criteria:** each item above individually verified; no acceptance criteria spans jurisdictions this roadmap doesn't already support.

**Explicitly deferred, not a PR here:** mileage offline-queue coverage (Finding #12) — logged as a known gap, revisit only if/when a PWA-writable mileage-capture UI actually ships, since no current code path can reach it.

## Execution note

PARITY-1 and PARITY-2 are the highest-value fixes — they're real money-estimate correctness bugs affecting every CA tenant (PARITY-1) and every AU/CA "what-if" chat query (PARITY-2), not cosmetic gaps. Recommend executing in the order listed (1 → 8), since PARITY-3 depends on nothing from 1/2 but shares no blocking dependency either — the ordering is by severity, not by technical prerequisite. Each PR follows the same worktree → plan → SDD → review → CI → merge cycle used throughout Phases 1-3.

---

## Final Sign-off

Once all three Gate tasks report a clean (zero Critical/High/Medium) result in sequence, AgentBook is launch-ready for US, CA, and AU per this roadmap's definition. Produce a final one-page summary (reusing the existing HTML-artifact reporting pattern) stating, per market: the SWOT, the verdict, and any Low-severity items intentionally deferred — so "launch ready" is a documented conclusion, not an assumption.
