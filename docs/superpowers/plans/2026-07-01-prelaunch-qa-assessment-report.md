# AgentBook Pre-Launch QA Assessment Report

**Date:** 2026-07-01
**Scope:** Full execution of `2026-07-01-prelaunch-qa-audit-plan.md` (v3, reviewed to ~98/100) across 5 phases, against production (`agentbook.brainliber.com`), using Playwright + live account probing (Maya persona + fresh throwaway accounts).

---

## 1. Launch verdict

**Conditional go.** The two Critical, launch-blocking defects that existed when this pass started have been fixed and verified live:

1. **Every chat-driven write action was completely broken** (record-expense, split-expense, edit-expense, and by the same code path create-invoice/categorize-expenses) — the single most fundamental capability of an "AI bookkeeping assistant" had no working path via chat at all. **Fixed and verified end-to-end.**
2. **The daily payment-reminders cron was unauthenticated and 500ing every single day**, silently never reminding anyone about an overdue invoice. **Fixed and verified.**

One Critical defect remains open and unfixed: **Plaid bank-connect never completes** (QA-P2-001) — Plaid's own UI reports success but the account never persists. This is the highest-priority open item and should be resolved before general availability, though it does not block a limited/beta launch if bank-sync is not advertised as day-one-reliable, since a user can still enter expenses manually and via chat.

Everything else found is High/Medium/Low severity with either a workaround or a clear, cheap fix path — detailed below with an explicit fix-now vs. backlog decision for each.

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
| **QA-P2-001** — Plaid bank-connect: modal says "Success," but `POST /plaid/exchange` never fires, account never persists (100% repro, 3/3 runs) | App-side handler (`BankConnection.tsx`) is correctly wired on read — root cause is most likely a `react-plaid-link` version/postMessage-handshake mismatch with the loaded Plaid `link.html` script, which needs a developer with Plaid SDK context, not a further QA pass. Already spawned as a separate background task this session. | Dev triage: check `react-plaid-link` version against the loaded `link.html` version; verify no CSP/extension is dropping the iframe's postMessage events. |

### High

| Finding | Why not fixed now | Recommended next step |
|---|---|---|
| QA-P3-001 — Analytics: category-breakdown 503s (all other `reports/*` routes in the same plugin work); Top Vendors shows `$NaN` | Backend route-registration bug + separate frontend/backend payload-shape mismatch — two distinct root causes bundled in one page, needs backend code-level investigation | Dev triage `reports/category-breakdown`'s handler registration; align vendors payload shape with what the frontend expects |
| QA-P3-002 — Reports page: all 4 report types fetch data successfully (200) but never render it — a silent no-op | Page-level rendering gap (fetch has nowhere to go) — real fix needs a decision on render surface (inline/modal/download) | Product + dev: decide the intended render surface, then wire it |
| QA-P5-001 — Dashboard sidebar has **no mobile breakpoint at all** (confirmed via source: zero `matchMedia`/responsive classes across `sidebar.tsx`/`app-layout.tsx`/`shell-context.tsx`) | Real responsive-design work (off-canvas drawer + hamburger pattern), not a one-line fix; affects every `(dashboard)` route via one shared component | Should be prioritized before any mobile-web traffic push; the fix is centralized (one shared shell), so it will resolve every affected page at once |
| QA-P3-005 (4 remaining sibling sites) — same missing `deletedAt` filter in `advisor/ask` (dead-code twin), `category-summary`, `agentbook-tax/reports/annual-summary`, and `query-finance` | Fixed the highest-traffic site (`query-expenses`) this session; the other 4 share the identical one-line fix but weren't independently verified against live data in this pass | Apply the same `deletedAt: null` fix to the other 4 sites; low risk, high confidence, same pattern already proven twice (PR #176, PR #179) |
| F4-03 / QA-P3-006 — "send an invoice to Acme for $500" misroutes to record-expense's generic failure message instead of invoice creation | `record-expense`'s `excludePatterns: ['^invoice\s', ...]` only anchors at the message *start*; widening it risks new false-negatives elsewhere in routing and needs its own regression pass, not a same-session drive-by | Fix the exclude pattern (e.g. `\binvoice\b` combined with send/create verbs) and add a regression test covering both phrasings before shipping |

### Medium

| Finding | Notes |
|---|---|
| QA-P3-003 — Cashflow page shows `$NaN` for current balance (backend value is correct; pure frontend field-mismatch) | Workaround exists (Tax Dashboard's own net-income figure shows the real number) |
| QA-P5-002 — Add-expense form fails completely silently on network error (console-only, no user feedback) | |
| QA-P5-003 — Invoice-send failure shows the raw `TypeError: Failed to fetch` string as a toast, fading in 3.5s; same pattern in `doVoid()` and the remind handler | Confirmed systemic within one file — fix should cover all 3 call sites together |
| QA-P5-004 — A failed dashboard data fetch renders identically to the legitimate "no sessions yet" empty state | |
| QA-P5-007 — Brand teal gradient color (`#62cda2`) fails WCAG AA contrast outright on white (1.95:1); primary teal (`#149578`) is large-text-only pass (3.75:1) | Formula-based estimate per plan scope — needs a follow-up grep-for-usage pass to convert to confirmed on-screen violations before treating as a hard blocker |
| QA-P2-002 — a second, working mobile-oriented PWA shell (`/app/*`) exists, is not dead code, but isn't linked from anywhere in the main app | Product decision (discoverability), not a bug |
| F4-04/F4-05/F4-06 — assorted Medium-severity chatbot phrasing/routing gaps from Phase 4 | Lower priority than the Critical/High items above; revisit after F4-03 |
| F6-1/F6-2 — an orphaned `agentbook-billing` plugin has UI surfaces and at least one unhandled 500 | Needs a product decision on whether this plugin ships at all before deciding whether to fix or remove |

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
