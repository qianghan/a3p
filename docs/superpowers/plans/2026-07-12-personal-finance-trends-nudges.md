# Personal Finance — Net-Worth Trends + Proactive Nudges — Implementation Plan (PR-2)

Design: `docs/superpowers/specs/2026-07-12-personal-finance-trends-nudges-design.md` (post-adversarial-review revision — read this first, especially the "Revision note" and the documented reconstruction limitations).

## Plan-level refinement found while writing this plan (flagging before execution, not silently deviating)

The spec says nudges are delivered by "folding into the existing daily `morning-digest` cron." Reading `morning-digest/route.ts` in full surfaced a problem with that literally: its tenant-selection query (`GET`, ~line 884) only includes tenants with `dailyDigestEnabled: true` OR a connected Telegram bot — **a `personal_insights` subscriber who has neither would never enter the loop at all**, so their nudges would silently never fire. Coupling into morning-digest's existing tenant-selection would also risk pulling personal_insights-only subscribers into the full digest pipeline (auto-categorize, tax tips, cash-flow tips, budget progress, bank-review messages) unless every section were individually re-guarded — a lot of surface area to touch in an already 1070-line file for what should be a narrow, independent check.

**Revised approach, same intent as the spec (reuse the proven delivery mechanism, avoid an unjustified cadence), different integration point:** a new, small, independent cron route — `apps/web-next/src/app/api/v1/agentbook/cron/personal-finance-nudge-check/route.ts` — that copies morning-digest's proven **hourly-triggered-but-self-gated-to-the-tenant's-local-morning-hour** pattern (the same `Intl.DateTimeFormat`-based local-hour check, ~15 lines, worth duplicating rather than refactoring morning-digest to share it under this PR's time budget) but selects tenants by `personal_insights` subscription instead of digest opt-in, and delivers via the same two calls the spec specified (`createNotification()` + `sendToAllChannels()`). This is a one-line-different tenant-selection query and a much smaller, independently testable route, not a new architecture — and it fixes a real correctness gap (nudges silently never firing for legitimate subscribers) that the spec's literal wording would have produced.

## Task 1 — Schema, billing add-on, and the Next.js route guard helper

**Files:**
- `packages/database/prisma/schema.prisma` — add `AbPersonalNudgeLog` (fields per spec: `id, tenantId, nudgeType, periodKey, category?, createdAt`, `@@unique([tenantId, nudgeType, periodKey, category])`).
- `bin/seed-personal-insights-addon.ts` (new) — mirrors `bin/seed-student-success-addon.ts` exactly: `personal_insights` add-on code, `isActive:false` by default (`ACTIVATE=1` to flip), single `'standard'` tier, `us`/`ca` regional pricing ($49 USD / $65 CAD, matching the `student_success` precedent).
- `apps/web-next/src/lib/agentbook-personal-insights/guard.ts` (new) — `requirePersonalInsightsAddon(request): Promise<{tenantId: string} | {response: NextResponse}>`, mirroring `lib/agentbook-student/guard.ts`'s `requireStudentAddon()` line for line (same fail-closed behavior, same `safeResolveAgentbookTenant` call, same 402 JSON shape with an on-brand upsell message — not a bare "add-on required" string).

**Note for the implementer:** this guard helper is for **Next.js API routes** only (Task 2, Task 5's teaser logic if server-rendered). It is a different runtime from `plugins/agentbook-core/backend/src/server.ts` (the plugin backend, used by Task 4) — do NOT try to import this Next.js-shaped helper into `server.ts`. `server.ts` already has its own established inline `hasAddOn(tenantId, code)` gating convention (see the existing eligibility gate for the student chat skills, ~line 3220) — Task 4 uses that pattern directly, not this file.

**Verification:** push schema to an isolated verify DB (per this session's standing practice — never `--accept-data-loss` against the shared `naap` dev DB), run the new seed script against it, confirm the add-on + price rows exist.

## Task 2 — Trend computation + trend API route

**Depends on:** Task 1 (guard helper).

**Files:**
- `apps/web-next/src/lib/personal-trend.ts` (new) — a pure function `computeNetWorthTrend(accounts: AbPersonalAccount[], transactions: AbPersonalTransaction[], months = 12): {month: string, netWorthCents: number}[]`. Implements the spec's reconstruction formula with both correctness rules: clamp each account's contribution to `0` for any month-end before `account.createdAt`; skip archived accounts entirely (both documented as accepted limitations in the spec, not bugs to solve differently here). Reuses `lib/personal-snapshot.ts`'s asset/liability sign convention (read that file first — same `isAsset`-based sign flip, applied per month-end, not just at "now").
- `apps/web-next/src/app/api/v1/agentbook-personal/trend/route.ts` (new) — `GET`, calls `requirePersonalInsightsAddon(request)` first (402 short-circuit on failure), then fetches the tenant's accounts + transactions and calls `computeNetWorthTrend()`.

**Tests:** unit tests for `computeNetWorthTrend()` — multiple accounts, transactions before/after month-end boundaries, an account created mid-window (asserting the `createdAt` clamp produces `0` for months before creation, not the account's full starting balance), a liability account (mortgage/credit) contributing negatively, an archived account excluded entirely. Route-level test for the 402/200 gate via `requirePersonalInsightsAddon`.

## Task 3 — Nudge checks: new cron route + notification categories

**Depends on:** Task 2 (trend module, for the net-worth-change check).

**Files:**
- `apps/web-next/src/lib/agentbook-personal-nudges.ts` (new) — `checkPersonalFinanceNudges(tenantId): Promise<NudgeResult[]>`. Three checks per the spec's pinned-down thresholds: budget-threshold (80%/100%, per category, using the existing `AbPersonalBudget` spent/remaining math from PR-1's budget route), net-worth month-over-month (`max($100, 5% of prior month's net worth)`, using two points from `computeNetWorthTrend()` — not a full 12-month recomputation), negative savings rate (this month's income − spending < 0, no banding). Each check queries `AbPersonalNudgeLog` for an existing `(tenantId, nudgeType, periodKey, category)` row before firing; inserts one on fire.
- `apps/web-next/src/app/api/v1/agentbook/cron/personal-finance-nudge-check/route.ts` (new) — per the plan-level refinement above: hourly-triggered, self-gated to the tenant's local morning hour (duplicate morning-digest's `Intl.DateTimeFormat` local-hour computation — small enough to duplicate, not worth a cross-file refactor here), selects tenants via an active `personal_insights` `BillAddOnSubscription` (not digest opt-in), calls `checkPersonalFinanceNudges()`, and for every fired nudge calls **both** `createNotification()` (dashboard) and `sendToAllChannels()` (Telegram) — matching the spec's two-channel requirement exactly. Support the same `?hour=now` bypass query param morning-digest already supports, for the same on-demand-testing reason.
- `vercel.json` — register the new cron, hourly cadence (matching `calendar-check`'s existing hourly entry — this cadence is now correctly justified, since the route only *acts* once per tenant per day; the hourly trigger is just how it finds "is it currently this tenant's morning").
- `apps/web-next/src/lib/notifications.ts` — add `budget_alert`, `net_worth_update`, `savings_warning` to `NOTIFICATION_CATEGORIES`. Do NOT add them to `COMPLIANCE_LOCKED_CATEGORIES`.
- `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` — add the 3 new categories to `NOTIFICATION_CATEGORY_LABELS`.
- `apps/web-next/src/app/(dashboard)/notifications/page.tsx` — add the 3 new categories to `CATEGORY_LABEL`.

**Tests:** unit tests for `checkPersonalFinanceNudges()` — crosses a threshold once → fires once; stays crossed on a later call within the same period → does not re-fire; drops below then re-crosses in a later month → fires again (fresh `periodKey`). Route-level test: for a subscribed tenant past a threshold, confirm both `createNotification` and `sendToAllChannels` were called and an `AbPersonalNudgeLog` row exists; calling the route again the same day does not duplicate.

## Task 4 — Extend `personal-snapshot` for trend queries

**Depends on:** Task 2 (trend module).

**Files:**
- `plugins/agentbook-core/backend/src/built-in-skills.ts` — extend `personal-snapshot`'s `triggerPatterns` with net-worth/personal-anchored **and** temporal-cue-combined phrasing, per the spec's design decision (never a bare temporal phrase alone — every new trigger must combine an anchor like `net worth`/`personal`/`household`/`savings rate` with a comparison cue like `trended`/`over time`/`compared to`/`vs last month`/`change`). Follow PR-1's established convention of shared pattern constants in `skill-routing.ts` over ad hoc per-skill regexes if a shared constant is reusable here; otherwise inline is fine for a single skill's own patterns.
- `plugins/agentbook-core/backend/src/server.ts` — extend `personal-snapshot`'s existing INTERNAL handler (do not create a new skill). Add the sub-classifier exactly as pinned down in the spec: if the matched trigger text also contains one of the temporal/comparison cues, treat as a trend query — check `hasAddOn(tenantId, 'personal_insights')` inline (server.ts's own established convention, see note in Task 1) and either call `computeNetWorthTrend()` for a real answer or return the on-brand upsell message (mirroring the scholarship/career/housing precedent's tone, not a bare "add-on required"); otherwise (no temporal cue matched) fall through to the existing free current-state path, completely unchanged from PR-1.

**Tests:** routing tests — the new trend-anchored phrases route to `personal-snapshot`; confirm no collision with `query-finance` (business revenue trends) or `query-past-filings` (year-anchored tax phrasing) by tracing the actual patterns, the same way PR-1's routing fixes were verified (a `node`/`tsx` script against the real `selectSkillByPatterns`, not just the test file's own possibly-biased helper). Handler tests: subscribed tenant asking a trend question gets real trend data; non-subscribed tenant asking the same gets the upsell message, never real trend data; a current-state question (e.g. "what's my net worth") is never gated regardless of subscription status — this is the PR-1-regression case, test it explicitly. One `channel:'mcp'` test confirming the same behavior through the MCP code path with no MCP-specific code required.

## Task 5 — UI: trend chart section on `/personal`

**Depends on:** Task 2 (trend route contract).

**Files:** `apps/web-next/src/app/(dashboard)/personal/page.tsx` — add a trend chart section (reuse the page's existing card conventions from PR-1, no new charting dependency needed for a simple 12-point line — check what's already available in the repo, e.g. any existing chart component used elsewhere on a dashboard page, before reaching for a new one). Fetch `GET /api/v1/agentbook-personal/trend`; on `200`, render the chart; on `402`, render a teaser/upsell card (matching the `student_success`-gated-plugin visibility precedent — visible-but-locked, not hidden) linking to the existing add-on subscribe route (`.../agentbook-billing/me/addons/personal_insights/subscribe`).

**Tests:** e2e — a subscribed tenant sees the real chart (assert it reflects known seeded data, not just "a chart element exists"); a non-subscribed tenant sees the teaser card and no chart data.

## Task 6 — Final e2e verification + full round-trip

**Depends on:** Tasks 3, 4, 5.

**Files:** `tests/e2e/personal-finance.spec.ts` (extend, existing tests untouched) — a budget-threshold nudge round-trip (create a budget, record a transaction crossing 80%, invoke the cron route with `?hour=now`, assert a notification exists + `AbPersonalNudgeLog` row + re-invoking doesn't duplicate); the trend UI subscribed/non-subscribed flows from Task 5; the `personal-snapshot` trend-query + current-state-regression + MCP-channel checks from Task 4, run together as a single coherent test rather than duplicating Task 4's unit-level coverage at the e2e layer.

## Process

Subagent-driven development, same discipline as PR-1: implementer subagent per task → task-scoped reviewer subagent → fix rounds until approved → final whole-branch review on the most capable model, with every regex/math/gate claim independently re-verified against the real code before accepting a fix (not just trusting the report) → commit → PR → merge to `main` → build + prebuilt deploy → seed `personal_insights` in production (inactive) → live e2e verification.
