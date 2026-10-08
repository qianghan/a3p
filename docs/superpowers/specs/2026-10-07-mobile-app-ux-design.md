# AgentBook Mobile App (`/app` PWA) — UX Redesign

Date: 2026-10-07 · Status: draft for review · Scope: the installable PWA at `/app`
(Home, Capture, Docs, Chat). **Not** the responsive desktop UI at `/agentbook`.

## 1. Problem

The mobile app is five route files (~590 lines, inline styles, mostly hardcoded English):

| Screen | Today | Gap |
|---|---|---|
| Home | 3 YTD tiles from `/tax/estimate` | No alerts, deadlines, overdue invoices, missing receipts, uncategorized count |
| Docs | Last 30 expenses with a paperclip link | No viewer, thumbnails, category display/edit, AI categorize, filters, update or archive |
| Capture | Photo → OCR → amount/vendor | No preview, category, date, personal/business; queued offline receipts are **orphaned** (replay hits `/receipts/scan`, which never creates an expense) |
| Chat | In-memory bubbles, plain text | No history, no plan Proceed/Cancel, no suggestion chips, no photo, no retry; fixed height ignores header and keyboard |

Backend facts that shape the design (verified in code, 2026-10-07): no document model (a "document" is an
`AbExpense` row with `receiptUrl`); no deadlines list route (`AbCalendarEvent` has no GET); `/expenses` has no
status/receipt/category/search filter and no `limit` cap; `PATCH /expenses/[id]` cannot set vendor, receipt or
status; receipts are full-size public Blob URLs; no bulk apply/reject for auto-categorize suggestions;
`overview` returns pre-written English alert text whose links point at desktop `/agentbook/*` pages and whose
"missing receipt" definition (60 days, no `deletedAt` filter) disagrees with `proactive-alerts` (over $25,
confirmed). Chat already supports `plan.requiresConfirmation` + `sessionAction`, `suggestions`, `attachments`
and thread history; the mobile page ignores all of it.

## 2. Goals and non-goals

Goals: a glance-then-one-tap app; Home shows what needs attention; Docs lets users see, inspect, categorize
(AI-first, manual fallback), edit and archive; Chat is reliable and rich; the common operations (snap, add,
categorize, remind, ask) take one or two taps; production-ready with test-based launch gates (section 8).

Non-goals: native iOS/Android app (design keeps contracts clean so screens can port to Expo later); Tailwind
migration; changing desktop UI; streaming chat; new bank/Plaid features; offline writes for Docs edits or Chat.

## 3. Principles

1. **Glance, then one tap.** Every screen opens on "what needs me?"; the primary action is a thumb-reach tap.
2. **Truthful states.** Loading, empty, error, offline and stale are distinct, labelled states, never a blank or a silent zero.
3. **One definition per number.** Each KPI/alert has one server-side definition, shared with the existing surfaces.
4. **Mobile destinations only.** No alert or button sends a phone user to a desktop page.
5. **Localized and money-safe.** All copy via `useT` (en / fr-CA / zh-CN); amounts via `formatCurrencyCents` in the tenant currency; tax-advice text stays English per existing `ENGLISH_ONLY_KEYS`.
6. **Touch-first.** 44×44 px minimum targets, safe-area padding, `100dvh` layouts that survive the keyboard.

## 4. Screens

### 4.1 Shell
Bottom tabs: Home · Docs · **Capture (raised center button)** · Chat. Tab badges: Docs shows the
needs-review count; Home shows the critical-alert dot. Header keeps `LanguageSwitcher`. Routing uses
`next/link` (no full reloads). Labels via `useT`.

### 4.2 Home
1. **Alert banner**, one card at a time, swipe/dots for more, ranked critical > warn > info, max 5. Kinds: `invoice_overdue`, `tax_deadline` (≤ 14 days), `receipts_missing`, `uncategorized`, `review_needed`, `bill_due`. Each has one action button to a mobile destination (e.g. Remind → in-place `POST /invoices/:id/remind`; Review → `/app/docs?filter=needs-review`).
2. **KPI strip** (4 tiles, tap → sheet with the breakdown): month-to-date net; cash today; outstanding invoices with overdue count/amount; estimated tax owed.
3. **Next up:** next 3 deadlines/bills with day counts.
4. **Recent activity:** last 5 items.
5. **Quick actions:** Snap receipt, Add expense, Ask advisor.
6. States: skeleton, brand-new-user empty state (existing three ActionCards kept), error with Retry, offline snapshot "as of HH:MM".

### 4.3 Docs
- Header banner: "AI categorized N · M need you" with **Review AI picks** and **Auto-categorize** actions.
- Filter chips: Needs review · No category · No receipt · All · Archived. Search box. Grid/list toggle. Infinite scroll (cursor).
- Thumbnails via the Next image optimizer.
- **Viewer** (full-screen route `/app/docs/[id]`): pinch-zoom receipt image (or a "No receipt — add photo" tile); editable vendor, category, personal/business, description (notes), and amount/date **only while the expense is pending review** (a confirmed expense is already booked and the shared PUT route does not re-post its journal entry, so amount/date are read-only with an explanation); AI suggestion chip with confidence and **Accept**; category picker sheet (expense accounts, recents first); **Archive / Restore**; **Delete** (existing soft-delete + reversing entry, confirm sheet); prev/next navigation.
- Rules: AI-categorized items show an "AI" pill and are one tap to change; items AI cannot categorize land in "No category" with the picker pre-opened on tap.

### 4.4 Capture
Camera-first. After the photo: preview, OCR prefill (amount/vendor/date, editable), category chip row (AI guess first), personal/business toggle, **Save** and **Save & next**. Online save → `POST /expenses/from-receipt`; offline save → queue (IndexedDB) with a visible "Queued · 2 waiting" pill and replay on reconnect to the same endpoint with an idempotency key. Manual entry (no photo) stays available.

### 4.5 Chat
Loads the active web thread (`/threads`, `/threads/:id/turns`) on open. Bubbles with light formatting (bold, line breaks, bullet lists; any Telegram-style HTML stripped). Typing indicator. When a reply has `plan.requiresConfirmation`: **Proceed / Cancel** buttons posting `sessionAction`. `suggestions[]` render as tappable chips. Photo attach (camera/library) sends `attachments`. Failed send shows inline **Retry** (message preserved). Rate-limit (429) shows the server `message` and disables send until `retryAfterMs`. Layout: header + scroll list + composer pinned with `100dvh`/`visualViewport` handling.

## 5. Backend

All new routes are Next.js route handlers under `apps/web-next/src/app/api/v1/...` (prod does not run the Express plugin backends), tenant-resolved with `safeResolveAgentbookTenant`, returning `{success, data}`.

**Schema (PR 1, own PR, merged first):** `AbExpense.archivedAt DateTime?` + `@@index([tenantId, archivedAt])`, and a nullable `AbExpense.idempotencyKey` (plain index, no unique constraint) for `from-receipt` dedupe. Additive only.

| Route | Behavior |
|---|---|
| `GET /agentbook-core/mobile/home` | Composes `kpis`, `alerts[]`, `nextUp[]`, `recent[]`, `currency`, `generatedAt` from shared helpers (extract from `dashboard/overview`, tax estimate, aging, quarterly) — never HTTP self-calls. |
| `GET /agentbook-core/calendar/upcoming?days=` | Merges `AbCalendarEvent`, quarterly tax payments and open bills; sorted by date. |
| `GET /agentbook-expense/expenses` (extend) | Add `status`, `hasReceipt`, `categoryId`, `archived` (default excludes archived), `q`, `cursor`; cap `limit` at 100 when any new mobile param is present (legacy desktop calls keep `limit=200`); response adds `categorySource`, `confidence`. Existing params/shape unchanged. |
| `PATCH /agentbook-expense/expenses/[id]` (extend) | Also accepts `vendor`, `date`. Existing fields unchanged. |
| `POST /expenses/[id]/archive`, `/unarchive` | Set/clear `archivedAt`; no journal entry, no total changes; idempotent. |
| `POST /agentbook-core/auto-categorize/review` | `{items:[{expenseId, action:'accept'|'reject', categoryId?}]}`; accept applies the suggestion via the existing categorize path (journal + vendor learning); max 50 items. |
| `POST /agentbook-expense/expenses/from-receipt` | Multipart `file` + optional overrides + `idempotencyKey`; uploads to Blob, OCRs, creates the expense (`pending_review` when confidence is low), returns the expense. Repeat key returns the original result. |

**Alert contract** (replaces pre-written English): `{id, kind, severity:'critical'|'warn'|'info', params, target:{route, query?} | action:{type:'post', endpoint, labelKey}}`. One server definition of "missing receipt": confirmed, not deleted, not archived, no `receiptUrl`, `receiptStatus != 'skipped'`, last 90 days, amount ≥ the proactive-alerts threshold; shared with `proactive-alerts` so both surfaces agree.

**Chat:** no backend changes.

## 6. Client architecture

- `app/app/_kit/` — Card, Sheet, Chip, Banner, Skeleton, Pill, Thumb, Toast, EmptyState (inline styles on existing CSS variables; semantic good/warn/critical colors separate from the brand accent; light and dark).
- `app/app/_lib/api.ts` — typed client, one function per endpoint, error normalization.
- `app/app/_lib/useMobileData.ts` — loading/error/retry/offline/stale state with last-good snapshot in `localStorage` (try/catch-guarded).
- Pages: `page.tsx`, `docs/page.tsx`, `docs/[id]/page.tsx`, `capture/page.tsx`, `chat/page.tsx`, composed from the kit.
- Service worker: `mobile/home` and `calendar/upcoming` added to `NEVER_CACHE_PATHS`; cache names bumped to v6; notification click default changed from `/agentbook` to `/app`. Offline queue replay retargeted to `from-receipt`.

## 7. Security and data integrity

- Every new route resolves the tenant from the session and scopes every query by `tenantId`; cross-tenant ids return 404.
- Archive never alters ledger, journal entries, tax estimate or P&L; tests prove it.
- `from-receipt` is idempotent; file type allow-list (jpeg/png/webp/heic/pdf) and size cap; no secrets or raw errors in responses.
- `auto-categorize/review` runs only the same categorize logic as the desktop path and rejects ids not belonging to the tenant.

## 8. Test-based production-readiness (the landing criteria)

Nothing ships on "it compiles". Each PR merges only when its **exit gate** passes in CI and is then
re-proven **on production** after deploy. Launch is gated on the **scorecard** in 8.6.

### 8.1 Test layers
1. **Unit/component (vitest + RTL):** every kit component and screen state (loading, empty, error, offline, stale, populated); banner ranking; filters; viewer edit/accept/archive; plan Proceed/Cancel; retry; 429 handling.
2. **API-client tests:** `_lib/api.ts` tested with a mocked `fetch` (not by mocking the module), covering success, non-2xx, malformed JSON, network failure, 429.
3. **Route tests:** each new/extended route, using DB mocks that **apply the `where` clause** so tenant-scoping and filter bugs fail the test. Cases: tenant isolation (other tenant's id → 404), every filter and cursor boundary, `limit` cap, idempotent archive/unarchive, `from-receipt` replay with the same key creates one expense, review bulk with a mix of valid/foreign ids, alert ranking and the single "missing receipt" definition shared with `proactive-alerts`.
4. **Invariant tests:** archiving/unarchiving leaves journal entries, `/tax/estimate`, and P&L totals byte-identical; `mobile/home` KPI values equal the values from the underlying existing endpoints for the same tenant and period; no `alerts[].target.route` starts with `/agentbook`.
5. **Offline/queue tests:** fake-IndexedDB tests that a queued receipt replays to `from-receipt` and yields exactly one expense, survives reload, and double replay is deduplicated; manual-expense queue unchanged.
6. **i18n guards:** existing catalog parity/wiring guards pass; no hardcoded user-visible English left in `/app` (grep guard); fr-CA and zh-CN checked in a real browser (green guards have previously coexisted with an English page).
7. **E2E (Playwright, 390×844, mobile UA, authenticated, against a real deployment):** assert **rendered content**, not just URL/link visibility. Journeys: (a) Home shows banner + 4 KPIs for a seeded persona; each alert action lands on a working mobile screen; (b) Docs: filter, open viewer, accept AI suggestion, manually categorize an uncategorized item, edit amount, archive then find under Archived then restore, delete; (c) Capture: photo (fixture image) → prefilled → save → appears in Docs; offline: context offline → queue → online → one expense; (d) Chat: history loads, a plan renders Proceed/Cancel, Proceed executes, suggestion chip sends, failed send retries; (e) tab navigation and deep links; (f) language switch.
8. **Regression suite:** existing `phase9-pwa.spec.ts`, `capture-page.test.tsx`, `mobile-home-empty-state.test.tsx` updated (not deleted); desktop expense list and categorize flows e2e unchanged; chat-quality and categorization suites green; full `Quality Gates` check green.

### 8.2 Persona matrix
E2E runs on Maya (CA, CAD), Alex (US, USD), Sydney (AU, AUD), and a brand-new empty account. Currency symbol/format, deadline sources, and tax-owed figures are asserted per jurisdiction; AU never shows US self-employment terms.

### 8.3 Non-functional gates
- **Performance:** Home interactive and showing KPIs ≤ 2.5 s on a throttled Slow-4G/mid-tier-phone profile; `/app/*` route JS ≤ the measured pre-change size + 40 kB gz (shared i18n catalog is already counted); Docs list of 100 items scrolls without layout shift (thumbnails sized); no render-blocking full-size receipt loads in lists.
- **Accessibility:** axe has zero serious/critical violations on all four screens and the viewer; every interactive target ≥ 44×44 px (asserted); visible focus; labelled icon buttons; contrast AA in light and dark; reduced-motion respected.
- **Resilience:** screenshots/asserts for offline, slow network (3 s delay), API 500, 429, and empty account on each screen; no unhandled promise rejections or console errors during the journeys.
- **PWA:** manifest/installability and service-worker checks pass; after deploy, a stale-SW client gets the new bundle (unregister-and-reload test plus the controllerchange path).
- **Security:** cross-tenant probes against every new route on staging/prod return 404/403; unauthenticated calls return 401; upload rejects wrong types/oversize.

### 8.4 Per-PR exit gates
Each gate = unit + route + e2e for that PR's scope green in CI → merge (never admin-bypass) → deploy → the same e2e journeys re-run against production with the persona matrix → results recorded in the PR before the next PR starts.

### 8.5 Rollout and rollback
Seven PRs: (1) schema + API routes; (2) kit + shell + tab bar + SW changes; (3) Home; (4) Docs + viewer; (5) Capture + offline fix; (6) Chat; (7) i18n completion, full e2e matrix, perf/a11y gates, cleanup. Each PR is independently revertible; the schema column is additive so reverting code never needs a DB rollback. If a production e2e journey fails after deploy, revert that PR before proceeding.

### 8.6 Launch scorecard
Launch ("production-ready") requires all of: all CI green on main; the 8.1(7) journeys 100% passing on production for all four personas; invariants in 8.1(4) passing; perf, a11y, resilience, PWA and security gates in 8.3 met; zero P0/P1 open; manual device pass on one iOS Safari and one Android Chrome install (add to home screen, camera capture, offline, push tap opens `/app`); results summarized in a launch report with pass/fail per gate.

## 9. Risks and open items (decided here, revisit if they bite)
- Thumbnails via the Next image optimizer require the Blob host in `remotePatterns`; if that proves unusable, fall back to client-generated thumbnails at capture time and `loading="lazy"` full images for legacy receipts.
- Deploy-race risk on the schema change is mitigated by landing PR 1 first and merging immediately.
- Desktop surfaces that list expenses will hide archived items; documented, and `includeArchived` exists if needed.

## 10. Plan
Implementation plan: `docs/superpowers/plans/2026-10-07-mobile-app-ux.md` (7 PRs, 76 tasks).
