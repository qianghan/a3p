# Personal Finance — Net-Worth Trends + Proactive Nudges (PR-2 of the personal-finance/tax-filing launch program)

## Context

PR-1 (merged, `#240`) shipped the transactions/budgets UI and a chat write-skill for the personal-finance plugin, closing the "you can't record anything without the API" gap. This is PR-2: the first genuinely premium personal-finance feature, and the first route in the whole repo to actually enforce `hasAddOn()` — the billing plumbing (`BillAddOn`/`BillAddOnPrice`/`BillAddOnSubscription`, `hasAddOn(tenantId, code)`) already exists and is proven for `student_success`, but a repo-wide grep found zero routes anywhere that actually call `hasAddOn()` at request time. This PR is where that changes.

Decisions already made with the user before writing this spec:
1. Nudges reuse the exact mechanism `tax_deadline` already uses live in production — a cron → `createNotification()` → dashboard bell/inbox + `AbEvent` for Telegram — not the fully-orphaned `packages/agentbook-framework` proactive-handlers engine (22 handler files, zero live callers, never run in production).
2. Billing gate is a new dedicated add-on (`personal_insights`), following the `student_success` pattern exactly, independent of the tenant's base plan tier.
3. v1 ships all three nudge triggers: budget-threshold crossed, net-worth monthly change, negative savings rate.
4. Trend window is trailing 12 months, monthly points.
5. Nudges deliver to both dashboard and Telegram (matching `tax_deadline`'s existing channels).

## Goal

Give a subscribed tenant a 12-month net-worth trend chart and three proactive nudge types, gated behind a new `personal_insights` add-on — while keeping the existing free `personal-snapshot` current-state chat answers (net worth right now, this month's spending) unaffected.

## Scope

**In scope:**
1. **Trend computation** — a pure function that reconstructs net worth at each of the trailing 12 month-ends from existing data: `account.balanceCents − Σ(that account's transactions dated after the month-end)`. No new schema for the historical data itself; this works immediately for every tenant with any transaction history.
2. **New model** `AbPersonalNudgeLog` — dedup guard so the cron doesn't re-fire the same nudge every hour within the same month. Fields: `id, tenantId, nudgeType, periodKey (e.g. "2026-07"), category (nullable, budget nudges only), createdAt`, unique on `(tenantId, nudgeType, periodKey, category)`.
3. **New billing add-on** `personal_insights` — new `BillAddOn`/`BillAddOnPrice` rows via a new seed script `bin/seed-personal-insights-addon.ts` (mirrors `bin/seed-student-success-addon.ts`: `isActive:false` by default, `ACTIVATE=1` to flip, single `'standard'` tier, `us`/`ca` regional pricing — same $49 USD / $65 CAD precedent as `student_success` unless told otherwise).
4. **New API route** `GET /api/v1/agentbook-personal/trend` — returns the 12 monthly net-worth points; 402 if the tenant lacks the `personal_insights` add-on (the actual enforcement — first of its kind in the repo).
5. **New nudge cron** `apps/web-next/src/app/api/v1/agentbook/cron/personal-finance-nudge-check/route.ts`, registered in `vercel.json` alongside the existing `calendar-check`/`daily-pulse` crons (hourly, matching `calendar-check`'s cadence). For every tenant with an active `personal_insights` subscription: checks each `AbPersonalBudget` for a newly-crossed 80%/100% threshold, checks this month's net worth vs. last month's from the trend computation, checks this month's income vs. spending for a negative savings rate — each gated by an `AbPersonalNudgeLog` dedup check before calling `createNotification()`.
6. **New notification categories** — `budget_alert`, `net_worth_update`, `savings_warning` added to the existing `NOTIFICATION_CATEGORIES` union (`apps/web-next/src/lib/notifications.ts`), NOT added to `COMPLIANCE_LOCKED_CATEGORIES` (these are value-add nudges, not mandatory like `tax_deadline` — a tenant can opt out via the existing notification preferences tab). The preferences UI's category list needs the same 3 additions wherever it enumerates them (task will locate and confirm the exact file — a repo-wide grep for `NOTIFICATION_CATEGORIES` usage found no `.tsx` consumer, meaning the preferences UI may hardcode its own list separately from the shared const, so this needs verifying directly against the real file, not assumed).
7. **Extend the existing `personal-snapshot` chat skill** (not a new skill) to recognize trend-shaped phrasing ("how's my net worth trended", "compared to last month", "over the last year") and answer from the new trend endpoint — gated the same way as the API route (a clear, on-brand upsell message if not subscribed, matching the tone of the existing scholarship/career/housing "part of X — enable it in Settings" precedent, not a bare 402 message). Current-state phrasing continues to route the same free path as today, unchanged.
8. **UI**: a trend chart section on `/personal`, gated with a teaser/upsell card for non-subscribers — following the same `student_success`-gated-plugin visibility precedent (a visible-but-locked card, not simply hidden) rather than invisibility. A minimal purchase entry point (link to the existing add-on purchase route already used by `student_success`, `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route.ts` — reused as-is, no new billing UI needed beyond wiring the `personal_insights` code through it).

**Out of scope (explicitly deferred):**
- Household/spousal sharing of trend data (PR-6+ territory per the gap review, not part of this program's launch scope).
- Any change to the free `personal-snapshot` current-state answers.
- Multi-jurisdiction currency work beyond what PR-1 already established (`jurisdiction-currency.ts` is reused as-is for the chart's axis/tooltip formatting).
- Retroactively enforcing `hasAddOn()` anywhere else in the repo (e.g. `tax_package_generation`) — this PR only wires the gate for its own new surface; other unenforced flags are a separate, already-flagged item (PR-5 touches `tax_package_generation` specifically).

## Design decisions

- **Reconstruction, not a snapshot table.** A monthly-snapshot cron would only start accumulating history from the day it first runs — meaning existing tenants like Maya would see a flat/empty chart for months. Reconstructing historical net worth from existing transaction rows means the chart is immediately populated and correct for any tenant with transaction history, at the cost of a somewhat more involved query (sum transactions after each month-end boundary, per account, per month) rather than a cheap snapshot read. Given `AbPersonalTransaction` volumes are small per tenant (personal finance, not a high-volume ledger), this is not a performance concern.
- **One add-on, three nudge types, one endpoint — not three separate gates.** Keeps the billing surface simple: a tenant either has `personal_insights` or doesn't; there's no need for granular per-nudge-type purchases in v1.
- **`AbPersonalNudgeLog` is intentionally minimal** — no soft-delete, no update path, just an insert-only dedup log. A nudge either fired for a given tenant/type/period/category or it didn't; there's nothing to edit.
- **Extending `personal-snapshot` over a new skill** keeps the free/paid split legible in one place (one skill, one gate check inside it) rather than splitting personal-finance chat behavior across two skills that could drift or double-trigger, mirroring the "don't add a skill when extending an existing one is cleaner" judgment already applied elsewhere this session.
- **Threshold values** are implementation-owned, not re-litigated with the user here, but pinned down concretely so independent implementation tasks don't diverge: budget nudges fire at 80% and 100% of the category limit (two distinct dedup periods, both keyed off the same `periodKey`+`category`, so crossing 80% then later 100% in the same month fires twice, not zero or once-only); the net-worth nudge fires when the month-over-month change exceeds `max($100, 5% of prior month's net worth)` in either direction (a $50 swing on a $500 net worth is noise, the same $50 swing on a $50,000 net worth is not — a pure percentage or pure absolute floor alone gets one of those two cases wrong); the savings-rate nudge fires whenever this month's income minus spending is negative, no threshold banding. All three are easy to tune later without a design change — the exact numbers are a config concern, not an architectural one.

## Test plan

- Unit: month-end net-worth reconstruction math (multiple accounts, transactions before/after boundaries, an account created mid-window), the nudge cron's threshold/dedup logic (crosses threshold once → fires once; stays crossed → doesn't re-fire same period; drops below and re-crosses next month → fires again), the `hasAddOn` gate on the trend route and the extended `personal-snapshot` skill.
- E2E: a subscribed tenant sees the trend chart + gets a real 200 from `/trend`; a non-subscribed tenant sees the teaser card + a 402; a budget-threshold nudge round-trips (create a budget, record a transaction that crosses 80%, run the cron logic directly or via the route, assert a notification + `AbPersonalNudgeLog` row exist, assert calling it again doesn't duplicate); the existing free `personal-snapshot` current-state test from PR-1 continues to pass unmodified.

## Rollout

Additive schema only (`AbPersonalNudgeLog`, new `BillAddOn`/`BillAddOnPrice` rows) — no destructive migration. Build → unit tests → task-scoped review per task → final whole-branch review → merge to `main` → build + prebuilt deploy → seed the `personal_insights` add-on in production (inactive until explicitly activated, matching `student_success`'s launch precedent) → live e2e verification, matching PR-1's process exactly.
