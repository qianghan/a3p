# Pre-Launch Comprehensive Quality Audit — Plan (v3)

**Date:** 2026-07-01 (v3 — revised after an independent adversarial review scored v2 at 61/100)
**Status:** Approved plan, ready to execute
**Scope:** agentbook.brainliber.com (production), user POV, medium+ severity issues
**Supersedes:** v2 of this doc. v2's independent review (see §Review history) found the coverage claim was not backed by an actual inventory of the codebase's surfaces — v3 fixes that by deriving the phase checklists FROM a full, code-derived inventory (§Phase 3.5) rather than asserting them, and closes every other gap the review raised.

## Review history (why v3 exists)

An independent review agent (not the author) scored v2 at **61/100** and found, by reading the code directly rather than trusting the plan's claims:
- The plan named **1 of 24** scheduled cron jobs.
- **~40% of dashboard pages** (`/treasury`, `/governance`, `/releases`, `/feedback`, `/teams`+subpages, `/accountant`, `/admin/observability`, `/admin/secrets`, `/admin/config`, `/admin/feedback`, `/plugins/[pluginName]`, `/embedded/[type]`) weren't mentioned.
- An entire plugin frontend (`agentbook-billing` — plan/subscribe/usage UI) and a **second, separate app shell** (`apps/web-next/src/app/app/*` — capture/chat/docs, distinct from the `(dashboard)` route tree) were missing entirely.
- Transactional emails, webhook resilience (Stripe signature failures, Telegram malformed payloads, dead-letter replay), and the PWA/service-worker/push surface had zero coverage.
- "Brand consistency" wasn't a falsifiable check. High vs. Medium severity had no decision rule. Inter-phase dependencies (Phase 6 blocked on the Stripe publishable key) were buried in a parenthetical instead of gating Phase 0.

All of that is fixed below. Where full execution of a surface isn't feasible in one pass, **v3 says so explicitly** in the inventory table rather than implying coverage it doesn't have — an honest map of depth beats a false claim of completeness.

## Why this is different from existing e2e coverage

The repo has ~77 Playwright specs under `tests/e2e/`, almost all **functional/regression** tests. They don't catch what a real user or a real chat conversation hits: confusing copy, dead ends, contradictory bot answers, non-actionable responses, accessibility gaps, mobile breakage, stale cron-sourced alerts. This is a **user-POV quality sweep**, not more feature tests.

## Tooling: Playwright vs. Chrome MCP — use both, deliberately

| | **Playwright** (`tests/e2e/*.spec.ts`) | **Chrome MCP** (`claude-in-chrome`: `navigate`, `computer`, `read_page`, `find`, `form_input`, `read_console_messages`, `read_network_requests`, `javascript_tool`, `gif_creator`) |
|---|---|---|
| Best for | Scripted, repeatable, assertion-based phases | Interactive judgment calls a script can't make — is this copy confusing? Does this layout look broken? Does this chat response feel evasive? |
| Re-runs later (CI/regression) | Yes | No — findings become Playwright regressions once confirmed |
| Chatbot phase (4) | Drives the API directly, asserts non-error/on-topic | **Primary tool** — read the rendered conversation like a user would; `read_network_requests` shows exactly what the classifier/skill received and returned |

**Rule of thumb:** Chrome MCP to *find and understand*, Playwright to *lock in* the regression once confirmed. Phase 4 is Chrome-MCP-led; Phases 0/1/2/3/5/6/7 are Playwright-led with Chrome MCP as a spot-check tool.

## Severity rubric + decision rule (closes the High/Medium ambiguity gap)

| Severity | Definition | Launch gate |
|---|---|---|
| **Critical** | Data loss/corruption, security/auth bypass, payment double-charge, can't sign up/log in, chatbot states something factually false about the user's own money | Blocks launch |
| **High** | Core workflow broken/misleading, OR a chatbot conversation that never reaches an actionable outcome | Blocks launch |
| **Medium** | Confusing/inconsistent UX, broken secondary flow, a11y violation on a primary path, unhelpful-but-not-wrong chatbot response, slow page (>3s TTI) | Fix before/soon after launch; tracked |
| **Low** | Cosmetic, copy nit, rare edge case | Backlog |

**Decision rule for the High/Medium boundary** (the gap the review flagged): *if the user can still complete the task via a visible workaround within 2 extra clicks/messages, it's Medium; if there is no completion path at all — not even a workaround — it's High.* Example: the categorize-expenses conversation is **High**, not Medium, because after 4 turns the user still cannot get a list of what to categorize through the chatbot at all (the only workaround, the Expenses page, wasn't offered as a concrete link/action — it was a bare mention).

**This audit's mandate: capture Medium and above.**

## QA-gap taxonomy — every finding gets bucketed, not just severity-rated

1. **Definition mismatch** — same concept, multiple divergent implementations. *If one instance exists, grep for siblings.*
2. **Non-actionable response** — correct diagnosis, nothing to act on.
3. **Context-blind multi-turn** — an obvious continuation isn't resolved from conversation history.
4. **Stale-data-presented-as-live** — a cron-computed value shown later without re-verification.
5. **Aggregate-instead-of-detail** — "list"/"show" answered with a sum.
6. **Accessibility / mobile / cross-browser gap.**
7. **Error-state gap** — a failure surfaces as a silent hang or raw error instead of a clear message.
8. **Coverage gap** — a real user-facing surface exists in the code with zero audit coverage (this bucket exists *because* v2 had this problem systemically — see §Phase 3.5).

## Closure workflow

1. Log every finding: `{ id, phase, severity, taxonomy bucket(s), surface, repro steps, expected, actual, evidence, sibling_check }` in `docs/superpowers/plans/2026-07-01-prelaunch-qa-findings.md`. **`sibling_check` is required, not optional**: the grep command run (or "N/A — not a definition-mismatch finding") plus its result, so pattern-checking is enforced by the schema, not left to memory.
2. **Critical/High** → fix immediately: root-cause, patch, self-review, deploy, prod e2e, merge — before moving to the next phase.
3. **Medium** → fix now if cheap (<30 min); else a tracked backlog item with owner + target.
4. **Pattern check**: any definition-mismatch or non-actionable finding isn't closed until its `sibling_check` grep has actually run and any siblings found are either fixed too or separately logged.
5. Regression tests only for confirmed Medium+ bugs, and must assert **rendered content/behavior**, not link-existence or URL-change (the exact gap that let the tax-nav bug ship past e2e in PR #174).
6. Re-run the specific failing scenario against prod after the fix ships.

## Personas

- **Maya** (`maya@agentbook.test`) — real seeded data; the Phase 4 worked-example persona
- **Jordan** (`jordan@agentbook.test`) — sparse data / empty-state journey
- **A brand-new throwaway signup** (`qa-audit+<timestamp>@example.com`) — true zero-data journey
- **Admin** (`qiang.han@gmail.com`) — admin console
- **The chatbot itself** — via web chat *and* Telegram, the surface most likely to hide unpolished UX because it's generative

## Blocking pre-conditions (Phase 0 must check these before anything else claims to be "done")

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is **not set** in prod — Phase 6's subscribe/payment-failure checks cannot execute until this is provided (Stripe has no API to fetch it; needs the dashboard). Phase 6 is marked **blocked, not skipped**, until resolved.
- Stripe account branding (logo) upload is blocked via API (Connect-only endpoint) — needs manual upload in the Stripe dashboard. Doesn't block Phase 6's functional checks, only the visual-branding sub-item.
- The categorize-expenses conversation bug (§Phase 4 worked example) must ship its fix before Phase 4's expense-categorization use case is considered executed, not just diagnosed.

## Phase 3.5 — Surface inventory reconciliation (NEW — the core fix for v2's 61/100)

Every phase's checklist below is now derived from this table, not asserted independently of it. Legend: **✅ covered** (named explicitly in a phase) · **◐ spot-check** (covered at a shallow pass, not full depth) · **☐ not covered, in-scope** (must be added to a phase before sign-off) · **— out of scope** (explicitly declared, with reason).

| Surface | Source | Status | Phase |
|---|---|---|---|
| Dashboard pages: accountant, feedback, governance, personal, releases, treasury, teams(+members/settings), plugins/[pluginName], embedded/[type] | `apps/web-next/src/app/(dashboard)/*` | ☐→✅ | Phase 3 (expanded below) |
| Admin pages: users, skills, plugins, payroll, config, observability, secrets, feedback | `(dashboard)/admin/*` | ☐→✅ | Phase 7 (expanded below) |
| Second app shell: `/app` home, capture, chat, docs | `apps/web-next/src/app/app/*` | ☐→✅ | Phase 3 (new bullet) |
| `agentbook-billing` plugin frontend (admin: AdminApp/PlanEditorModal/PlanList/TemplatePicker; user: PlanGrid/SubscribeModal/UpgradeTimingModal/UsageBars) | `plugins/agentbook-billing/frontend/src/*` | ☐→✅ | Phase 6 (expanded below) |
| Core plugin pages: Accounts, Activity, Agents, Ledger, Onboarding/OnboardingChat, Projections, SavedSearches, SkillMetrics, TelegramSettings, HomeOffice | `plugins/agentbook-core/frontend/src/pages/*` | ◐ | Phase 3 spot-check pass (full depth is its own future session) |
| Expense plugin pages: Bills, Vendors, BankConnection/BankReview, PerDiem, Mileage, Budgets, Receipts, NewExpense | `plugins/agentbook-expense/frontend/src/pages/*` | ◐ | Phase 3 |
| Invoice plugin pages: Clients, Estimates, Projects, Timer, RecurringInvoices, InvoiceDetail/List, NewInvoice | `plugins/agentbook-invoice/frontend/src/pages/*` | ◐ | Phase 3 |
| Tax plugin pages: Quarterly, Deductions, CashFlow, Analytics, WhatIf, Reports, PastFilings, TaxPackage | `plugins/agentbook-tax/frontend/src/pages/*` | ◐ | Phase 3 |
| 24 cron jobs (full list below) | `vercel.json` `crons[]` | ☐→✅ | New §Cron verification (under Phase 3/4) |
| Webhooks: Stripe, Telegram | `.../stripe-webhook`, `.../telegram/webhook` | ☐→✅ | New §Webhook resilience (Phase 6/Phase 5) |
| Transactional emails: verify-email, password-reset, CPA-invite, morning-digest, payment-reminders | `lib/email.ts` + callers | ☐→✅ | New §Email quality (Phase 1) |
| Exports/reports: 13 tax report types, mileage export, CSV import/export, aging report, data export, tax e-file XML | `agentbook-tax/reports/*`, `agentbook-expense/{mileage,import}/*`, `agentbook/me/export`, `agentbook-invoice/aging-report` | ◐ | Phase 3 spot-check (open one of each category, confirm it renders/downloads without error) |
| PWA/service worker/push | `public/manifest.json`, `public/sw.js`, `lib/register-sw.ts`, `api/v1/push/subscribe` | ☐→✅ | New §PWA check (Phase 5) — explicitly in scope, not silently dropped |
| Mobile native app | searched, none found | — out of scope | This is a PWA, not a native app; no mobile-specific test needed beyond the 375px responsive pass already in Phase 5 |

### Cron verification (24 jobs) — for each: what it feeds, what "correct" means

| Cron | Feeds | Verification |
|---|---|---|
| `proactive-alerts`, `auto-categorize-watchdog` | Chatbot proactive messages | **Highest priority — this is the exact family of bug found live.** Re-run manually, compare its computed counts against the Expenses page UI for the same tenant; must agree. |
| `morning-digest`, `daily-pulse`, `weekly-review` | Email/chat digest content | Numbers in the digest match the dashboard at time of generation. |
| `recurring-invoices`, `payment-reminders` | Invoice emails | Triggers only for genuinely due/overdue invoices — spot check against invoice list. |
| `plaid-sync` | Bank transaction feed | Spot-check via Plaid sandbox that a synced transaction appears correctly. |
| `deduction-discovery`, `home-office-quarterly` | Tax suggestions | Suggestion appears on the Tax dashboard/Deductions page, not just in a log. |
| `fx-rates` | Multi-currency conversion | Rate used in a real conversion matches. |
| `dead-letter-replay` | Failed-job recovery | **Webhook resilience item** — force a failure, confirm it lands in dead-letter, confirm replay actually recovers it. |
| `daily-backup`, `purge-deleted`, `audit-retention`, `memory-prune` | Data hygiene | Spot-check: run once, confirm no user-visible data loss (these touch retention/deletion — Critical severity if they ever delete live, non-expired data). |
| `skill-error-budget` | Admin skill-health page | Numbers shown on `/admin/skills` reconcile with actual recent errors. |
| `recognize-revenue`, `cpa-review` | Accounting/CPA portal | Spot-check one tenant. |
| `reset-quotas`, `cleanup-events` (billing) | Usage quotas | Quota shown to user resets when the cron says it did. |
| `onboarding-nudge`, `calendar-check` | New-user nudges, calendar reminders | Fires only when genuinely applicable (not a stale/repeat nudge — same taxonomy bucket as the categorize-expenses bug). |
| `/gw/admin/health/check` (5-min) | Platform health | Confirm it doesn't itself generate noisy false alerts. |

### Webhook resilience (Phase 6/5)

- **Stripe webhook**: invalid signature → clean 400, no crash, no data mutation. Duplicate event (same `stripeEventId`) → idempotent no-op (already coded per `BillEvent.stripeEventId` unique constraint — verify it holds under a genuine replay, not just code-read).
- **Telegram webhook**: malformed/unexpected payload shape → doesn't 500, doesn't crash the session state machine.
- **Dead-letter replay**: force a failure into the dead-letter queue, confirm `dead-letter-replay` cron actually recovers it end-to-end (not just marks it retried).

### Email quality (Phase 1, expanded)

For each of verify-email, password-reset, CPA-invite, morning-digest, payment-reminders: render the actual template (send-to-self or inspect the HTML string directly), check for broken template variables, working links, reasonable mobile-client rendering (the raw inline-HTML style used in `lib/email.ts` is a known risk for mobile clients), and that none of it reads as spam-trigger phrasing.

### Brand consistency (Phase 1) — made falsifiable

Concrete check, not a vibe: brand teal is `#149578`/`#62cda2` (gradient), used on the landing nav+footer wordmark, the auth screens, and the primary CTA color across the app shell. The `<Wordmark>` component (not the old PNG) renders on: landing nav, landing footer, login, register, forgot-password, reset-password. Fail this item if any of those six placements still shows the old asset or an off-brand color — that's a literal grep-and-visual-check, not a judgment call.

## Phases

### Phase 0 — Setup & instrumentation
- Confirm prod-safe test accounts.
- Playwright helpers: console-error collector, network-failure collector, page-load timer.
- Chrome MCP reachability check against prod.
- **Check the blocking pre-conditions above and record their state** — don't discover a block mid-phase.

### Phase 1 — Unauthenticated / marketing surface
- Landing page: CTAs, responsive, brand-consistency check (concrete, above).
- `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`: every error state is clear and non-technical.
- OAuth entry points.
- `/docs` nav.
- **Email quality pass** (above).

### Phase 2 — First-run onboarding (zero-data journey)
- Fresh signup → first login → clear next action on every plugin page, including the **`/app` capture/chat shell** (new — previously missing).
- Email verification end-to-end.
- Connect-bank from zero. Scan first receipt from zero.
- Referral banner + Referrals tab deep-link.

### Phase 3 — Core workflows per plugin + full page sweep (Maya, real data)
- **Core**: dashboard, ledger, activity feed, agents page, **plus a spot-check pass on Accounts, Onboarding/OnboardingChat, Projections, SavedSearches, SkillMetrics, TelegramSettings, HomeOffice** (previously unlisted).
- **Expense**: list/filter/search, categorize, split, OCR, recurring detection, budgets, **plus Bills, Vendors, BankReview, PerDiem, Mileage**. Cross-check the "uncategorized" count across the Expenses page, the proactive-alert/watchdog crons, and the chatbot — the exact seam that broke; verify all agree post-fix.
- **Invoice**: create → send → mark paid → recurring; PDF; client portal link; **plus Clients, Estimates, Projects, Timer**.
- **Tax**: dashboard, quarterly, deductions, past-filings upload, tax package export, Dashboard↔Tax Package nav (regression-check PR #175); **plus CashFlow, Analytics, WhatIf, Reports** (previously unlisted).
- **Payroll**: run payroll happy path, year-end forms.
- **Personal finance / Accountant (CPA portal)**: read-only CPA link works without an account.
- **Dashboard-level pages previously missing**: `/accountant`, `/feedback`, `/governance`, `/personal`, `/releases`, `/treasury`, `/teams`+subpages — one pass each: loads without error, primary action works.
- **The second app shell** (`/app`, `/app/capture`, `/app/chat`, `/app/docs`) — confirm this is either a deliberate alternate UI (test it as its own journey) or dead/legacy (flag for removal if unreferenced — don't leave an untested surface live either way).
- **Exports spot-check**: open one tax report, the mileage export, one CSV import, and the account data export — each downloads/renders without error.

### Phase 4 — Chatbot / agent-brain conversational quality (Chrome-MCP-led)

**Actionability rubric** (unchanged from v2 — this part scored well): a response passes only if it (a) gives the specific data asked for, (b) offers a concrete action, or (c) asks one precise question that resolves the request. Restating the problem or pointing to "the X page" without narrowing further **fails**.

**Worked example — now scored High, not Medium, per the decision rule** (Maya, Telegram, all 4 turns non-actionable, no workaround offered):

| Turn | User | Bot | Verdict |
|---|---|---|---|
| 1 | *(proactive)* | "You have 4 uncategorized expenses..." | Fails + factually wrong (definition-mismatch; root cause found: `auto-categorize-watchdog` counts `categoryId: null` with **no status filter**, so it counts expenses in states — draft/voided/disputed — that can never be resolved by categorizing and don't appear on the Expenses page at all) |
| 2 | "Categorize expenses" | "I reviewed 4 expenses but couldn't categorize them confidently..." | Fails (a)/(b) — the handler already fetched the 4 rows and discards them instead of listing them in this response branch |
| 3 | "List them here so I can do it" | "What would you like me to list for you?" | Fails (c) — context-blind; no entity for the pronoun-resolution pass to bind to, and neither the regex router nor the LLM classifier's prompt treats a bare continuation as "same topic as previous turn" |
| 4 | "List the non categorized expenses" | "$2069.98 in uncategorized expenses... please provide more details" | Fails (a) — real per-transaction data was already fetched server-side but the LLM prompt has no "enumerate" instruction and collapses it to an aggregate |

**Fix status**: root-caused in full (7 divergent "uncategorized" query implementations found across the codebase — see fix PR); shipping as its own PR before this use case is marked executed.

**Use-case matrix** (unchanged structure from v2, now explicitly includes cross-plugin + platform-parity rows per the review):

| Category | Example prompts | What "actionable" looks like |
|---|---|---|
| Record an expense | "spent 40 on lunch", "paid $120 at Staples yesterday" | Confirms and books it, or asks the one missing field |
| Query/list data | "how much did I spend on travel", "list my uncategorized expenses", "show unpaid invoices" | Actual rows/amounts when the user says "list"/"show" |
| Correction / follow-up | "no that was actually travel", "list them here", "the second one" | Resolves from the immediately preceding turn |
| Ambiguous / already-resolved state | "categorize expenses" with zero uncategorized | States the true state plainly — never repeats a stale alert |
| Out-of-scope | "should I incorporate in Delaware" | Declines gracefully, redirects |
| Casual/typo phrasing | "hows my taxes lookin", "wut do i owe" | Understood without rephrasing |
| **Cross-plugin task** (new) | "send an invoice to Acme for $500", "what's my Q3 estimate", "run payroll for July" | Routes to the right plugin's skill, not just expense-domain examples |
| **Platform parity** (new) | Ask the identical question on web chat and on Telegram | Same factual answer on both — a divergence here is a Critical-bucket definition mismatch |
| Multi-step task | "split this expense 60/40 between client A and B" | Completes it or asks the one blocking question |
| Long/rambling or empty input | 3-sentence ramble; empty/whitespace message | Extracts the ask, or asks for clarification without being condescending |
| Proactive/cron-sourced messages | any proactive alert | Re-verified live at send time, not cached-and-replayed |

Drive via Chrome MCP; screenshot/gif every multi-turn failure; log with taxonomy bucket + rubric-failure reason + `sibling_check`.

### Phase 5 — Cross-cutting quality
- Accessibility: keyboard-only pass, screen-reader labels, contrast on brand teal.
- Mobile: 375px viewport pass through Phases 1–3's primary flows.
- Performance: flag any primary page >3s load or visible layout jump.
- Error states: kill a network request mid-flow on 3–4 critical actions.
- Cross-browser: Chromium + one WebKit pass on the top 5 journeys.
- **PWA check (new)**: manifest.json is valid and linked, service worker registers without error, push-subscribe flow doesn't throw (full push-delivery testing is out of scope for this pass — note as a backlog item, not silently skipped).

### Phase 6 — Money paths (billing, referral, Stripe) — **blocked on publishable key, see Phase 0**
- Referral: joined → paid → referrer credited, visible on the Referrals tab.
- Subscribe/cancel/reactivate/proration — every state transition, no stuck loading states.
- **`agentbook-billing` plugin UI (new)**: PlanGrid, SubscribeModal, UpgradeTimingModal, UsageBars as a user; AdminApp/PlanEditorModal/PlanList/TemplatePicker as admin.
- A deliberately failing payment — clear message.
- Webhook resilience (above).

### Phase 7 — Admin console
- Users, skills, feature flags, LLM provider config, payroll providers — click-through.
- **Previously missing, now explicit**: `/admin/plugins`, `/admin/config`, `/admin/observability`, `/admin/secrets` (credential-handling surface — treat with security-adjacent scrutiny, not a casual click-through), `/admin/feedback`.

### Phase 8 — Triage & fix
Per the Closure Workflow: Critical/High fixed same-session; Medium fixed-if-cheap or backlogged with owner+target; every definition-mismatch/non-actionable finding's `sibling_check` actually run before closure; regression tests assert real content/behavior.

## Execution notes

- Each Playwright-led phase is its own spec file under `tests/e2e/qa-audit-<phase>.spec.ts`, run against production.
- Phase 4 output is Chrome-MCP session findings plus, for confirmed bugs, a Playwright regression + a real fix through the standard PR cycle.
- **Realistic sizing, stated honestly**: Phases 0–2 and the ✅ items in Phase 3 fit one focused pass. The ◐ (spot-check) items in Phase 3.5 get a real but shallow pass in the same session — full depth on every one of ~35 plugin pages is its own multi-session effort and is flagged as such, not claimed as done. Phase 4 is its own focused session given the expanded matrix. Phase 6 is blocked until the publishable key arrives. Phase 7 is quick. Cron verification and webhook resilience are spot-checked for the highest-risk items (proactive-alerts family, Stripe/Telegram webhooks, dead-letter) in this pass; the remaining ~18 lower-risk crons get a lighter "does it run without erroring" check rather than full output-verification, and that distinction is preserved in the findings report rather than flattened into one "cron: done" line.
