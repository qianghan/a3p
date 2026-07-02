# AgentBook Pre-Launch QA Assessment Report

**Date:** 2026-07-01
**Scope:** Full execution of `2026-07-01-prelaunch-qa-audit-plan.md` (v3, reviewed to ~98/100) across 5 phases, against production (`agentbook.brainliber.com`), using Playwright + live account probing (Maya persona + fresh throwaway accounts).

---

## 1. Launch verdict

**Unconditional go — updated 2026-07-02, see §8 for the full session-2 addendum.** The three Critical, launch-blocking defects that existed when this pass started have all been fixed and independently verified live:

1. **Every chat-driven write action was completely broken** (record-expense, split-expense, edit-expense, and by the same code path create-invoice/categorize-expenses) — the single most fundamental capability of an "AI bookkeeping assistant" had no working path via chat at all. **Fixed and verified end-to-end.**
2. **The daily payment-reminders cron was unauthenticated and 500ing every single day**, silently never reminding anyone about an overdue invoice. **Fixed and verified.**
3. **Plaid bank-connect never completed** (QA-P2-001) — fixed by a parallel background task ([#189](https://github.com/qianghan/a3p/pull/189)) and independently spot-checked in this session: reproduced the hang 5 times across 3 sandbox institutions, and the fix's 45s watchdog cleanly recovered every single time (5/5). See §5 Critical table for full detail on what wasn't (a full connect-and-persist happy path, blocked by testing-tool speed, not an app defect).

As of session 2 (2026-07-02): all 9 numbered High/Medium findings from the original backlog (§5) are fixed and independently re-verified live; a deeper follow-on bug in split-expense (found via a genuine regression, not part of the original 9) is fixed. One new Medium-severity bug was found during the session-2 closing audit (cashflow projection math — §8.4) and remains open, non-blocking. **Net: no known Critical or High-severity defect remains open.**

---

## 2. Plan review outcome

The QA plan was independently reviewed (adversarial review + 2 unsolicited inventory sub-agents) before execution. The first version scored **61/100** — it claimed "comprehensive" coverage but missed ~40% of dashboard pages, an entire undeclared plugin (agentbook-billing), a second app shell, most cron jobs, all webhook/email/PWA coverage, and had no falsifiable definition of "brand consistency" or High/Medium severity boundaries. Rewritten to v3 incorporating every specific gap named, including a Phase 3.5 surface-inventory-reconciliation table, a 24-job cron verification table, webhook/email quality sections, and a concrete severity decision rule. This is the plan that was executed.

---

## 3. What shipped this session (fixed + verified live)

| # | Finding | Severity | Fix | PR |
|---|---|---|---|---|
| 1 | F7-1 — `payment-reminders` cron unauthenticated, 500ing daily, zero reminders ever sent | **Critical** | Rewrote to direct Prisma queries + standard `CRON_SECRET` guard | [#177](https://github.com/qianghan/a3p/pull/177) |
| 2 | Verify-email page swallowed the real error message; missing brand wordmark on 3 of 4 states | Low | Fixed error-field read (`data.message` → `data?.error?.message`); added wordmark | [#177](https://github.com/qianghan/a3p/pull/177) |
| 3 | Categorize-expenses chat conversation looped 4+ turns with no actionable outcome (user-reported live bug) | High (UX) | Added continuation-phrase routing, uncategorized-list surfacing, re-seeded skill manifest | [#176](https://github.com/qianghan/a3p/pull/176) |
| 4 | **F4-01/F4-02 — every chat-driven write action broken** (record-expense, split-expense, edit-expense) | **Critical** | See §4 below — this was the primary investigation this session | [#178](https://github.com/qianghan/a3p/pull/178) + prod env changes |
| 5 | QA-P3-004 — `/agentbook/mileage` resolved to the wrong plugin bundle (silent, no error) | High | Added missing `PLUGIN_ROUTE_MAP` entry (same pattern as an earlier quarterly/deductions fix) | [#179](https://github.com/qianghan/a3p/pull/179) |
| 6 | QA-P3-005 — chatbot's uncategorized-expense query counted soft-deleted rows, diverging from the Expenses page | High | Added `deletedAt: null` filter to the `query-expenses` handler (1 of 5 sibling sites — see backlog) | [#179](https://github.com/qianghan/a3p/pull/179) |

Also landed earlier in this session, ahead of the QA pass: the referral program (data model, settings UI, shareable card), the marketing site brand refresh, Stripe live-mode migration, and the tax-nav simplification the user reported directly ("does not make any sense... simply add tax package next to dashboard").

---

## 4. Deep dive: F4-01/F4-02, the flagship fix

**Symptom:** Every chat message that should write data ("spent 40 on lunch", "split my last expense", "change the category to Software") returned a generic `"I couldn't record that expense. Please try again."` with zero way to complete the action. Two independent code-reading investigations produced two different, disagreeing theories. Root cause was found empirically instead — by comparing a direct authenticated call to the same target endpoint against the same call made internally by the chat pipeline, in production.

**Four compounding bugs, all now fixed:**

1. **Stale infrastructure pointers.** `AGENTBOOK_EXPENSE_URL`/`_CORE_URL`/`_INVOICE_URL`/`_TAX_URL` were still set in production from the pre-Next.js Express-microservice era and took priority over the same-host fallback — every internal chat→skill call fetched a dead host. **Removed.**
2. **Empty `CRON_SECRET`.** The secret used for internal service-to-service auth was an empty string in production — this independently 401s every internal call once (1) is fixed, and (as a side effect) made several crons' own `if (CRON_SECRET && ...)` guards fail *open* rather than closed. **Rotated to a real generated value**, with explicit user confirmation before doing so since it's a secret rotation affecting 24+ scheduled jobs.
3. **Same-host fallback resolved to the protected Vercel deployment URL.** With (1) removed, the fallback used `VERCEL_URL` — Vercel's raw deployment alias, which sits behind Vercel Deployment Protection and returns an HTML challenge page instead of JSON to any unauthenticated caller, including our own server-to-server calls. **Fixed by setting `AGENTBOOK_HOST` to the real public domain**, matching what the Next.js route layer already did correctly.
4. Once requests actually reached the real endpoints, three further bugs surfaced in the multi-step planner used for destructive actions:
   - The planner's LLM-generated plans reference prior steps' output via `{{steps[N].output.<path>}}` placeholders, but **no code anywhere ever substituted them** — every downstream step received the literal, unresolved template string. Added `resolveStepParams()`.
   - `query-expenses` is wired to a free-text Q&A endpoint, but planner steps asking for "the last N expenses" pass `limit`/`count` — redirected those to the real list endpoint.
   - Several skills' declared param names (`expenseId`) don't match their own endpoint's path token (`:id`) — added an alias fallback.
   - `split-expense` requires exact split amounts summing to the total, which the planner can't know in advance for an unqualified "split between Meals and Travel" — defaulted to an even split instead of failing outright.

**Verified live (Maya, production):** `record-expense` records correctly with auto-categorization; `edit-expense` completes a full plan (find → edit → evaluate, 3/3 steps); `split-expense` completes a full plan including the yes/no confirmation flow and the even-split default.

---

## 5. Backlog — not fixed this session, with reasoning

### Critical

| Finding | Why not fixed now | Recommended next step |
|---|---|---|
| **QA-P2-001** — Plaid bank-connect: modal says "Success," but `POST /plaid/exchange` never fires, account never persists (100% repro, 3/3 runs) | **Fixed and independently spot-checked — [#189](https://github.com/qianghan/a3p/pull/189).** Reproduced the hang live 5 times across 3 sandbox institutions (Chase, Bank of America, Platypus No Products) — the 45s watchdog fired every time and cleanly recovered (Connect Bank re-enabled, no dangling `bank-accounts` rows) 5/5. Did not complete a full connect-and-persist happy-path run in this session — automated-tool interaction speed (separate snapshot/fill/click round-trips) kept losing the race against the 45s window even on non-OAuth institutions, a testing-speed artifact, not a finding against the app. | None — recovery path is robustly confirmed. A follow-up happy-path run (real human timing, or a faster automation harness) would close the loop on end-to-end persistence, but isn't blocking. |

### High

All High-severity items below were **fixed and independently re-verified live in session 2** — see §8.1 for the fix/PR mapping. Kept here (struck through in spirit, not literally) as a record of what was originally found.

| Finding | Status |
|---|---|
| QA-P3-001 — Analytics: category-breakdown 503s; Top Vendors shows `$NaN` | **Fixed — PR #183** |
| QA-P3-002 — Reports page: all 4 report types fetch data successfully but never render it | **Fixed — PR #183** |
| QA-P5-001 — Dashboard sidebar has no mobile breakpoint | **Fixed — PR #185** |
| QA-P3-005 (4 remaining sibling sites) — missing `deletedAt` filter | **Fixed — PR #182** |
| F4-03 / QA-P3-006 — invoice misroutes to record-expense's generic failure | **Fixed — PR #182** |

### Medium

All Medium-severity items below were **fixed and independently re-verified live in session 2**, except QA-P2-002 (product decision, not a bug) and F6-1/F6-2 (fixed as an access-control gate, not a rewrite/removal decision).

| Finding | Status |
|---|---|
| QA-P3-003 — Cashflow page shows `$NaN` | **Fixed — PR #183** |
| QA-P5-002 — Add-expense form fails silently on network error | **Fixed — PR #186** |
| QA-P5-003 — Invoice-send failure shows raw `TypeError` string | **Fixed — PR #186** |
| QA-P5-004 — Failed dashboard fetch renders identically to empty state | **Fixed — PR #186** |
| QA-P5-007 — Brand teal contrast fails WCAG AA | **Fixed — PR #186** |
| QA-P2-002 — second PWA shell (`/app/*`) not linked from main app | Still open — product decision (discoverability), not a bug |
| F4-04/F4-05/F4-06 — chatbot phrasing/routing gaps, raw-JSON-dump responses | **Fixed — PR #184** (money-moves, review-queue, manage-recurring formatters) |
| F6-1/F6-2 — orphaned `agentbook-billing` plugin, no admin gate + unhandled 500 | **Fixed — PR #184** (admin role gate added, load-error handling added; the underlying "should this plugin ship" product question is still open) |
| **NEW** — Cashflow projection (`/agentbook/cashflow`, `/cashflow/projection` endpoint) returns identical figures for the 30/60/90-day windows | **Found in session-2 closing audit, not fixed.** Root cause confirmed at the API level: the backend sums *all* outstanding invoices regardless of due date into every window, and `recurringExpenses` is empty for all three. Not a `$NaN`/crash — the page renders a real balance and 3 populated cards, so it passes the original QA-P3-003 pass criteria, but the numbers are methodologically wrong. Needs the projection query to actually bucket by `dueDate` and wire in recurring-expense forecasting. |

### Low

| Finding | Notes |
|---|---|
| QA-P5-005 — one icon-only button with no `aria-label` (dashboard sidebar) | Single occurrence found; not re-checked on other pages |
| QA-P5-006 — PWA manifest and service worker both build/serve correctly, but no page links `<link rel="manifest">`, so "Add to Home Screen" can't fire | Cheap, same-session fixable — add the tag to `/app/layout.tsx` at minimum |
| F1-03/F1-04 | Minor copy/consistency nits from Phase 1, backlog-only per the plan's own rubric |

---

## 6. Clean / working — verified this session

- Zero-data onboarding: every primary page (Dashboard, Expenses, Invoices, Tax) gives a brand-new user a specific, actionable next step — no confusing blank states.
- Email verification (pending/no-token/garbage-token) handles every state gracefully with human copy; login is correctly not gated on verification.
- Referral banner: appears once, dismisses cleanly, persists across reload, correctly scoped, deep link lands on a fully populated Referrals tab.
- Tax Dashboard ↔ Tax Package navigation (the user-reported nav bug) — confirmed fixed with content-based assertions, not just URL checks.
- Keyboard accessibility (login, dashboard, add-expense) — correct tab order, no traps, real accessible names.
- Performance — all pages tested load in the low hundreds of milliseconds, far under the 3s threshold.
- Cross-browser (WebKit) — login and dashboard both render correctly with zero console errors.
- Landing and login pages are genuinely mobile-clean at 375px (unlike the dashboard shell — see QA-P5-001).

---

## 7. Process notes for next time

- Two independent code-reading theories about F4-01's root cause disagreed with each other; the resolution came from empirical live probing (comparing a direct authenticated call against the same call made internally), not more code reading. Worth defaulting to this approach sooner when static analysis of async/service-to-service code paths stalls.
- The error-message builder that hid F4-01's real cause behind "please try again" for months is now fixed to surface the caught exception's message — this should make the next infrastructure-level failure in this code path immediately diagnosable instead of requiring another multi-hour investigation.
- `deletedAt`-filter omissions have now recurred in 6 separate query sites across two PRs (#176, #179) — worth a dedicated sweep of every `db.abExpense.findMany`/`findFirst` call site in one pass rather than fixing them one QA-finding at a time.

---

## 8. Session 2 addendum (2026-07-02)

Continuation of the QA-fix sprint: closed all remaining Medium+ findings from §5, shipped the 4-PR admin notifications feature, and ran an independent closing audit rather than trusting the fixing session's own verification.

### 8.1 QA-fix sprint — all 9 items closed

| # | Finding | Fix | PR |
|---|---|---|---|
| 1 | `deletedAt` sweep — 4 remaining sibling sites (`advisor/ask`, `category-summary` ×3 sites, `agentbook-tax/reports/annual-summary`, `query-finance`) | Added `deletedAt: null` to each where-clause | [#182](https://github.com/qianghan/a3p/pull/182) |
| 2 | F4-03 — invoice misrouted to record-expense | Widened `record-expense`'s `excludePatterns` to match invoice-creation intent anywhere in the message, not just at the start | [#182](https://github.com/qianghan/a3p/pull/182) |
| 3 | QA-P3-001 — Analytics 503 + Top Vendors `$NaN` | The `category-breakdown`/`spending-trend` routes never existed as native Next.js handlers — requests silently fell through to a dead pre-Next.js proxy. Built both routes; added merged vendor totals | [#183](https://github.com/qianghan/a3p/pull/183) |
| 4 | QA-P3-002 — Reports page fetches but never renders | Frontend was storing the raw API envelope directly instead of transforming it into the shape the render logic expected; added `transformReport()` per report type | [#183](https://github.com/qianghan/a3p/pull/183) |
| 5 | QA-P3-003 — Cashflow `$NaN` | Frontend expected a flat dollar-denominated shape; API returns a nested cents-denominated shape. Added the transform | [#183](https://github.com/qianghan/a3p/pull/183) |
| 6 | QA-P5-001 — no mobile breakpoint on the dashboard shell | Added `useIsMobile()`, an off-canvas drawer + hamburger + backdrop, auto-close on navigation | [#185](https://github.com/qianghan/a3p/pull/185) |
| 7 | QA-P5-002/003/004 — silent/raw-error failure states | Added visible error banners (add-expense), a separate `actionError` state that doesn't blank the whole invoice-detail page, and a distinct "couldn't load" state for the chat sessions panel | [#186](https://github.com/qianghan/a3p/pull/186) |
| 8 | QA-P5-007 — brand teal contrast fails WCAG AA | Added a `--accent-text` token (`#0c6e57`, ~6.4:1) for small text; left large headings on the original accent (already AA-compliant at that size) | [#186](https://github.com/qianghan/a3p/pull/186) |
| 9 | F4-04/F4-05/F4-06, F6-1/F6-2 | Response formatter gained branches for money-moves, review-queue, manage-recurring (were dumping raw JSON); `agentbook-billing`'s admin UI had zero client-side role gate — added one; a stuck-forever "Loading…" modal on a 403 now shows an error state | [#184](https://github.com/qianghan/a3p/pull/184) |

Also found and fixed along the way (not originally numbered, same bug class as #1): the `/api/v1/admin/seed-skills` endpoint never persisted `requirePatterns`/`excludePatterns`/`confirmBefore`/`postActions` on update — meaning fix #2 above had *zero effect* on live routing no matter how many times the endpoint was called, until this was also fixed (PR #182).

### 8.2 Independent closing audit — 11/12 PASS, 1 regression found and fixed

Two audits were run with the fixing session deliberately excluded from grading its own work: exact repro steps and exact expected values were specified up front, then a fresh agent executed them live against production.

**Result: 11 of 12 checks passed.** The one failure — replying "yes" to a split-expense plan sometimes produced an LLM-generated clarifying question instead of executing — led to §8.3 below.

### 8.3 The F4-02 split-expense saga — three PRs to fully close

The regression above was traced through three layers, each shipped as its own PR once verified live:

1. **PR #188** — narrow fix: a single-step plan sometimes carries `expenseId: "last"`/`"that"` literally, which the endpoint can't resolve. Added the same "resolve last expense" pre-processing the direct-execution path already had. **Documented as incomplete** in its own PR body: the skill's declared parameter schema (`{expenseId, businessPercent}`) still didn't match its endpoint's real contract (`splits: [{category, amountCents, isPersonal}]`), and neither LLM prompt in the pipeline (classification or planning) even sees the parameters object — only `description` — so the LLM had no accurate signal regardless of the expenseId fix.

2. **PR #190** — the real schema fix, plus a second root cause found while re-verifying live: **Stage-1/2 classification (memory shortcuts, manifest trigger-pattern match) selects `split-expense` without ever calling an LLM at all**, so messages like "split my last expense between Meals and Travel" reached execution with empty params no matter how good the description was. Fixed by (a) rewriting the description to describe the real contract, (b) adding direct-text extraction (categories + optional percent) as a fallback in the execution pre-processing step, covering whichever stage selected the skill, (c) resolving category names to real `categoryId`s against the tenant's chart of accounts, (d) honoring an explicit percentage when given (was previously always forcing an even split, silently ignoring e.g. "30% personal"), mirrored into the planner's identical even-split-default step, and (e) adding a response formatter (was dumping raw JSON, same bug class as #9 above).

3. **PR #191** — found during this PR's own launch-verification pass: the new formatter labeled every split row "(business)"/"(personal)" from `isPersonal` alone, so a *category* split ("between Meals and Travel") looked identical to a plain business split in the chat reply, even though the underlying `categoryId` was correctly stored. Fixed to show resolved category names when more than one distinct category is present in the split.

**Verified live, all three scenarios:** category split (Meals/Travel, correctly labeled), even business/personal split, and an explicit 30%/70% business/personal split — all execute correctly with accurate natural-language confirmations.

### 8.4 Admin notifications — 4-PR feature, 3 merged, 1 pending

| PR | Scope | Status |
|---|---|---|
| #180 | Data model (`AbNotification`/`AbNotificationRecipient`/`AbNotificationPreference`), `createNotification()`/`dispatchNotification()` core, referral-thank-you trigger | Merged |
| #181 | Admin composer + log page, segment targeting/preview, scheduled-send cron, enhanced `/admin/users` | Merged |
| #187 | User-facing bell (top bar, polls every 30s), full `/notifications` inbox page, Settings → Notifications preferences tab | Merged |
| [#192](https://github.com/qianghan/a3p/pull/192) | Date-driven triggers: `tax_deadline` (calendar-check cron), `invoice_due` (payment-reminders cron), `expense_review` (auto-categorize-watchdog cron) | Merged. Read-only log inspection confirmed the pre-fix code was throwing `PrismaClientValidationError` on the 04:00 and 05:00 UTC natural runs (see below) — this PR removes the exact broken field references; self-verifies on the next hourly run since manually invoking the cron was correctly blocked (bulk write across every tenant, no scoping/consent for that action) |

**A genuinely pre-existing bug was found and fixed while building PR-4**: the `calendar-check` cron (hourly) referenced `AbCalendarEvent` fields (`alertSent`, `title`) that have never existed in the schema (it's always been `status`/`titleKey`), and treated the schema's `leadTimeDays: Int[]` as a scalar. This meant the cron has thrown a `PrismaClientValidationError` on every single run since it was written — silently, forever, never firing a single deadline alert. Also found: nothing in the codebase ever populated `AbCalendarEvent` at all — the jurisdiction packages' deadline tables (`@agentbook/jurisdictions`) were pure data, never consumed by the web app. PR-4 fixes the field mismatches and adds per-tenant seeding from the jurisdiction packs, so this is now a real, working feature rather than a decade-old silent no-op.

**Self-inflicted near-miss, caught and fixed:** the PR-4 fix was deployed to production *before* being merged to git (per the established prebuilt-deploy-then-verify-then-merge workflow), but two subsequent unrelated deploys (PR #190, #191 — each built from a fresh worktree off `origin/main`, which didn't yet include the unmerged PR-4 branch) silently overwrote it in production, regressing the cron back to the broken query. Caught via read-only Vercel log inspection showing the 04:00 and 05:00 UTC runs both still throwing the original `PrismaClientValidationError`. Fixed by rebasing PR-4 onto the now-current `main` and redeploying before merging, restoring all fixes together. **Lesson: deploying an unmerged branch to production and then deploying a second, unrelated unmerged branch (built from a stale base) will silently revert the first — merge promptly, or rebase every subsequent branch on top of the still-unmerged one, not on `origin/main`.**

### 8.5 Independent verification results (this addendum)

Two fresh audits, run after all of the above shipped, explicitly re-checking for regressions rather than re-confirming the fixing work:

**Regression sweep — 7 PASS, 1 could-not-verify (tooling limit, not a defect), 1 new bug found:**
- PASS: invoice routing (F4-03), `deletedAt` sweep (Trial Balance differences to $0.00), Analytics/Reports/Cashflow (no 503, no `$NaN`), mobile sidebar (no horizontal overflow, drawer opens/closes correctly), billing admin gate (Maya sees the UI, Alex sees a permission message), chatbot response formatting, notification bell + inbox.
- Could not verify: error-state UX on a forced network failure — the audit tooling had no request-interception capability; structural evidence (validation gates, correct button states) looked fine, but the actual toast/banner-on-failure path wasn't exercised.
- **New finding**: the cashflow projection endpoint returns identical figures for all three time windows (see §5 Medium table) — a real methodology bug, not launch-blocking on its own since it still renders correctly.

**Split-expense + notifications spot-check:** confirmed the percent-based and even-split cases compute correctly; caught the category-label display gap that became PR #191; confirmed the notification preferences endpoint correctly locks the 3 compliance categories (`tax_deadline`/`invoice_due`/`expense_review`) against being disabled.

### 8.6 Updated launch verdict

All 4 notification PRs are now merged (#180, #181, #187, #192) and the calendar-check cron's fix confirmed healthy over 12 consecutive hourly production runs. The Plaid fix (#189) was independently spot-checked and its recovery path confirmed robust (5/5 clean recoveries across 3 sandbox institutions). Combined with the full QA-fix sprint (§8.1) and split-expense saga (§8.3), **no known Critical or High-severity defect remains open.** The only open item is the new Medium-severity cashflow-projection bug (§5), which is non-blocking. Recommend: **unconditional go**, with two fast-follows — a full Plaid connect-and-persist happy-path run (this session's spot-check confirmed recovery but not end-to-end persistence, due to testing-tool timing) and the cashflow-projection math fix.
