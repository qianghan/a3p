# Pre-Launch QA Audit — Findings Log

Findings are appended per phase as executed. Schema: `{ id, phase, severity, taxonomy bucket(s), surface, repro steps, expected, actual, evidence, sibling_check }`.

## Phase 2 — First-run onboarding (zero-data journey)

Executed via Playwright against production (`https://agentbook.brainliber.com`), using a genuinely new throwaway account registered via the public signup API: `qa-audit-onboarding+<timestamp>@example.com` (multiple timestamps used across re-runs; all left inert, no cleanup, per the established convention in `tests/e2e/admin-users-actions.spec.ts`). Throwaway spec: `tests/e2e/qa-audit-phase2.spec.ts` (deleted after this pass per instructions — findings below are the durable artifact). One self-inflicted, non-product IP-based login rate-limit (10 req/60s, `apps/web-next/src/lib/api/rate-limit.ts`) was hit twice from repeated isolated re-runs during this session; both times resolved by waiting for the window to clear, and the final clean single-process runs (all 20-21 tests in one `npx playwright test` invocation) are the basis for every finding below — no finding rests on a rate-limited run.

---

### QA-P2-001

- **Severity:** Critical
- **Taxonomy:** #7 Error-state gap
- **Surface:** Plaid bank-connect flow, `/agentbook/bank` (`plugins/agentbook-expense/frontend/src/pages/BankConnection.tsx`) — Plaid Link sandbox, from a genuinely zero-data account
- **Repro steps:**
  1. Register a brand-new throwaway account, log in, navigate to `/agentbook/expenses`.
  2. Click the "Connect Bank" CTA in the "🏦 Connect your bank for automatic import" banner → navigates to `/agentbook/bank` (a plain `window.location.href` redirect, confirmed in source).
  3. On `/agentbook/bank`, click "Connect with Plaid" in the "No banks connected yet" empty-state card.
  4. A real Plaid Link modal opens in an iframe (`https://cdn.plaid.com/link/v2/stable/link.html?...token=link-sandbox-...`), confirming `POST /api/v1/agentbook-expense/plaid/link-token` is correctly called and returns a valid 200 sandbox token.
  5. Click through Plaid's own flow: "Continue without phone number" → search institution "Platypus" → select "Platypus No Products" (12 accounts) → enter `user_good` / `pass_good` → submit → click the follow-up "Continue"/"Connect" (account-selection) step.
  6. Plaid's own modal then displays: **"Success — Your account has been successfully linked to AgentBook"** (screenshotted).
  7. The modal never closes on its own — waited an additional 8 seconds; the iframe and the "Success" screen are still present, with **zero further buttons to click** (no "Done," no auto-dismiss).
  8. Checked the actual network traffic for the entire flow: **no `POST /api/v1/agentbook-expense/plaid/exchange` request was ever made** — only repeated `GET /api/v1/agentbook-expense/bank-accounts` polling calls.
  9. Called `GET /api/v1/agentbook-expense/bank-accounts` directly via in-page `fetch()` immediately after Plaid's "Success" screen appeared: `{"success":true,"data":[]}` — zero accounts, server-side.
  10. Reloaded the page fully: still "No banks connected yet." Reproduced 3 times across 3 separate clean test runs (3 different sandbox link tokens, 3 different fresh accounts) — 100% reproduction rate, no flake.
- **Expected:** After Plaid confirms a successful link, `react-plaid-link`'s `onSuccess` callback fires, the app calls `POST /plaid/exchange` with the `publicToken`, the account is persisted, the modal closes, and the Bank Connections page shows the newly connected account (per the code's own `onPlaidSuccess` handler in `BankConnection.tsx` lines 88-110, which is correctly wired to `usePlaidLink({ onSuccess: onPlaidSuccess })` on read).
- **Actual:** Plaid's own UI reports success, but the host app's `onSuccess` callback appears to never fire (or fires without effect) — no exchange call, no persisted account, no UI transition. The user is left staring at a "Success" message with no way to proceed and no bank ever actually connected. This is the most consequential zero-data-journey flow tested in this phase (bank connect is the single highest-leverage onboarding action for a new bookkeeping user) and it does not work at all, with no visible workaround from the UI itself.
- **Evidence:** Screenshot showing Plaid's "Success — Your account has been successfully linked to AgentBook" with the underlying page still reading "No banks connected yet" (`/private/tmp/.../scratchpad/p2-plaid-before-close-check.png`); network log across 3 runs showing zero `plaid/exchange` calls; direct API check `{"success":true,"data":[]}` captured 3 times.
- **Severity note:** Rated Critical, not High, because the plan's Critical bar includes "can't complete a core setup action at all" for a flow this central to onboarding, and because a stuck modal with no dismiss path and a false "Success" message is actively misleading — the user has no way to know their bank is *not* connected short of independently reloading and reading the empty state, and no way to dismiss Plaid's modal to try again without navigating away (closing the browser tab or hitting back is the only exit observed).
- **sibling_check:** Ran — read `plugins/agentbook-expense/frontend/src/pages/BankConnection.tsx` end to end. `onPlaidSuccess` (lines 88-110) and the `usePlaidLink` wiring (lines 112-120) look correct on static read: `onSuccess: onPlaidSuccess` is properly passed, and `onPlaidSuccess` does call `fetch(`${API}/plaid/exchange`, ...)`. Since the code path looks right but never executes, the likely root cause is upstream of this file — either a `react-plaid-link` version/event-handshake mismatch with the loaded `link.html` v2.0.2473 script (the modal's internal "Success" screen is Plaid's own rendering, not this app's, so the disconnect is in the postMessage handshake between the iframe and the host SDK), or the modal is stuck on Plaid's own optional "save your info with Plaid" phone-linking upsell state and never reaches the point where Plaid's SDK calls the host's `onSuccess`. Did not check other Plaid-adjacent flows (e.g. a re-connect/re-auth flow for an already-connected account) for the same symptom — no second Plaid entry point exists in the app to check as a sibling. Recommend this be dev-triaged with a `react-plaid-link` version check and a look at whether `link.html`'s postMessage events are being intercepted/dropped (e.g. by a CSP header, an ad-blocker-like extension in the test environment, or a version skew) before assuming the app-side handler itself is at fault.

---

### QA-P2-002

- **Severity:** Medium
- **Taxonomy:** #8 Coverage gap (informational — resolved to "deliberate, working, but thin" rather than "uncovered")
- **Surface:** Second app shell — `/app`, `/app/capture`, `/app/chat`, `/app/docs` (`apps/web-next/src/app/app/*`)
- **Repro steps:**
  1. Log in as the fresh throwaway account, navigate to each of the 4 paths directly.
  2. `/app`: renders "AgentBook / Year to date" with Revenue $0, Expenses $0, Estimated tax $0 (all correctly zeroed, no NaN/crash), plus a "Snap a receipt" card pointing to the Capture tab. Bottom tab bar: Home / Capture / Docs / Chat.
  3. `/app/capture`: renders a working "Take a photo of the receipt" upload control plus manual Amount/Vendor fields and a "Save expense" button — a real, usable expense-entry form, not a stub.
  4. `/app/chat`: renders "Ask AgentBook" with example prompt text and a working text input wired to `POST /api/v1/agentbook-core/agent/message`.
  5. `/app/docs`: renders "No expenses yet. Capture one to get started." — a correct, explicit empty-state CTA pointing back at Capture.
  6. Zero console errors and zero page errors across all 4 paths (checked via `page.on('console')`/`page.on('pageerror')`).
- **Expected:** N/A for this line item — this was originally a "is this dead code or deliberate?" open question from the plan's Phase 3.5 inventory, not a presumed defect.
- **Actual:** This is a small, deliberate, functioning mobile-oriented PWA shell — separate React tree, separate layout, separate bottom-tab nav, calling real backend endpoints (tax estimate, expense list, receipt OCR scan, expense create, agent chat) and handling the zero-data state correctly on every one of its 4 pages. It is not dead/abandoned code. It is, however, materially thinner than the main `(dashboard)` experience (no invoices, no tax detail beyond one estimate tile, no settings) and there is no visible in-app link from the main `(dashboard)` shell pointing a user to `/app` — it's only reachable by direct URL, which is itself worth a product decision (is this meant to be discoverable, e.g. as a "install the mobile app" prompt, or is it an internal/future-facing shell not yet meant to be found by real users?).
- **Evidence:** Rendered body text captured for all 4 paths (quoted above); zero console/page errors logged.
- **Severity note:** Logged as Medium/informational rather than a hard defect, since nothing crashes or misleads — the gap is discoverability and scope-thinness relative to the main shell, not brokenness. Flagging for a product decision, not a code fix.
- **sibling_check:** N/A — not a definition-mismatch or non-actionable-response finding. Did not grep the main `(dashboard)` shell for any link to `/app` in this pass; a quick follow-up grep for `href="/app"` or `router.push('/app')` across `apps/web-next/src/app/(dashboard)` would settle definitively whether it's linked anywhere today.

---

### Non-findings — checked and passed clean

- **Registration → login, no email-verification gate:** A brand-new account can register (`POST /api/v1/auth/register` → 200, "check your email for verification steps") and immediately log in and reach `/agentbook` with a live session — confirmed login is not blocked by an unverified email (no `emailVerified` check found in the login code path). This is a deliberate, reasonable choice for a self-serve product and not flagged as a defect; noting it here only because it's exactly the kind of order-of-operations a QA pass should confirm rather than assume.
- **Main dashboard `/agentbook` zero-data state:** Renders the sidebar nav, the dismissible referral banner, a "SESSIONS / No sessions yet." panel, and a populated AgentBook chat widget with concrete example prompts ("give me a daily briefing," "expense summary," "log $5 coffee") — a real, actionable next step is presented, not a bare blank page.
- **Expenses page (`/agentbook/expenses`) zero-data state:** Shows "0 expenses · $0.00," a prominent "+ Record" button, the "🏦 Connect your bank for automatic import" CTA banner (see QA-P2-001 for what happens when you follow it), a "Record a few more expenses to unlock spending insights" hint, and example Ask-the-agent prompts ("Top spending?", "Any duplicates?"). This page gives a genuinely new user multiple clear next actions — no confusing blank state here.
- **Invoices page (`/agentbook/invoices`) zero-data state:** Shows "Manage and track all your invoices," a "New Invoice" button, "TOTAL OUTSTANDING $0.00," status tabs all showing "(0)," and explicit copy: **"No invoices found — Create your first invoice to get started."** Clear, actionable empty state.
- **Tax page (`/agentbook/tax`) zero-data state:** Shows "TOTAL ESTIMATED TAX $0.00," Income Tax/SE Tax/Effective Rate all correctly zeroed (no `$NaN`), Revenue vs Expenses all $0, and a distinct, well-formed "Upload prior-year returns" CTA card ("Bring last year's tax returns — we'll extract the figures and use them to prefill and advise"). A genuinely new user has a clear, non-blank next action here too.
- **`/expenses`, `/invoices`, `/tax` (without the `/agentbook` prefix):** All three correctly 404 with a clean "Page Not Found / The page you are looking for does not exist or has been moved. / Go Home" message — no crash, no confusing raw error, sensible fallback link. Confirmed these are simply not valid routes in this app (the canonical paths are `/agentbook/expenses` etc.), not a broken link anywhere in the product driving users to a dead URL.
- **Email verification, pending state (no token):** `/verify-email` with no token and no stashed pending-email in `sessionStorage` shows a clear, friendly "Verify your email / Please check your email for the verification link." plus a checklist ("Check your spam or junk folder," "Make sure you entered the correct email," "Wait a few minutes and try again") and a "Back to login" link. With a stashed email (the real post-registration path, since `register-form.tsx` sets `sessionStorage.setItem('pendingVerificationEmail', ...)` before redirecting), it additionally names the email and offers a working "Resend verification email" button.
- **Email verification, garbage token:** `/verify-email?token=totally-garbage-token-does-not-exist-123` shows a clean "Verification failed / Verification failed" message with a "Go to login" link — no crash, no raw stack trace, no blank page. (The doubled "Verification failed" heading-and-body text is a minor copy nit, not logged as a separate finding — Low severity, backlog-only per the plan's rubric, not worth its own entry.)
- **`POST /api/v1/auth/resend-verification`:** Called directly for the fresh unverified account → `200 {"success":true,"data":{"message":"Verification email sent"}}`. Works as expected.
- **Referral banner — appears once, dismiss works, persists across reload:** On a completely fresh `/agentbook` load (localStorage cleared), the banner "Invite a friend — for every paid signup you get 1 month free, up to a year." appears exactly once (count=1). Clicking the dismiss (X, `aria-label="Dismiss"`) button removes it immediately (count=0). Reloading the page keeps it gone (count=0), and `localStorage.getItem('ab_referral_banner_dismissed')` correctly reads `"1"` afterward. Reproduced cleanly in a single-process run. Also confirmed the banner is scoped to `/agentbook` only — count=0 on both `/agentbook/expenses` and `/agentbook/invoices` in the same session, matching the component's own `pathname !== '/agentbook'` guard.
- **Referral banner deep link:** Clicking "Invite now" navigates to `/settings?tab=agentbook&subtab=referrals`, which correctly lands on a fully-populated Referrals tab: referral code (`G58R-9V9U`), a working share link (`.../register?ref=G58R-9V9U`), copy/share buttons (X, LinkedIn, WhatsApp), a "0 / 12 months earned" progress indicator, and an explicit "No invites yet — share your link above to get started" empty state for the invitee list. Deep link works exactly as specified.
- **Plaid `link-token` endpoint availability:** `POST /api/v1/agentbook-expense/plaid/link-token` reliably returns 200 with a valid sandbox `linkToken` across every run in this pass — the token-issuance half of the flow is solid; it's specifically the post-Plaid-success exchange step that's broken (QA-P2-001). (Two other guessed endpoint names, `plaid/create-link-token` and `bank/link-token`, correctly 503 with a clear "Plugin service agentbook-expense is unavailable" JSON error rather than a raw crash — reasonable behavior for a nonexistent-route probe, not a finding.)

---

## Phase 2 verdict

Phase 2 found one Critical defect and one Medium/informational item, against an otherwise clean zero-data onboarding experience. The Critical finding (QA-P2-001) is serious: the Plaid bank-connect flow — arguably the single most valuable "first action" for a new bookkeeping user — walks a user all the way through Plaid's real sandbox UI to a "Success" message and then silently fails to persist the connection, with no closing action, no error, and no indication anything went wrong; reproduced 3-for-3 with zero flake, and the app-side code that should handle it (`BankConnection.tsx`'s `onPlaidSuccess`) looks correct on read, meaning the fault most likely sits in the Plaid Link SDK handshake, not obviously in application logic — this needs a developer, not a QA pass, to resolve, and it must not ship broken. Every other zero-data primary page (`/agentbook`, Expenses, Invoices, Tax) gives a brand-new user a clear, specific next action — none of them are the "confusing blank state" the plan worried about; this is a genuine strength of the current build. Email verification is handled gracefully at every state tested (pending-with-email, pending-without-email, garbage token) with human-readable copy and no crashes, and login is correctly not gated on verification, so a new user is never stuck. The referral banner is fully correct: appears once, dismisses cleanly, stays dismissed across reload, is properly scoped to the dashboard home only, and its deep link to Settings > Referrals lands exactly where expected with a fully working Referrals tab. The second app shell (`/app` + 3 sub-pages) resolved the plan's own open question — it is a small, deliberate, working mobile-oriented PWA, not dead code — though it's thinner than the main app and currently only reachable by direct URL, which is worth a product decision on discoverability before launch, not a code fix. No code was changed in this pass, per QA-tester scope; QA-P2-001 blocks launch per the plan's Critical-severity gate until a developer resolves it.

---

## Phase 3 — Core workflows per plugin + full page sweep (Maya, real data)

Executed via Playwright against production (`https://agentbook.brainliber.com`), logged in as `maya@agentbook.test`. Throwaway spec: `tests/e2e/qa-audit-phase3.spec.ts` (deleted after this pass per instructions — findings below are the durable artifact).

---

### QA-P3-001

- **Severity:** High
- **Taxonomy:** #7 Error-state gap
- **Surface:** `/agentbook/analytics` (Expense Analytics — Tax plugin's Analytics page, listed ◐ spot-check in Phase 3.5 inventory)
- **Repro steps:**
  1. Log in as Maya, navigate to `/agentbook/analytics`.
  2. Observe "Category Breakdown (YTD)" shows "Total $0" despite Maya having ~$9-12K in YTD expenses.
  3. Observe every row under "Top Vendors" shows correct transaction counts (e.g. "2 transactions") but `avg $NaN` and `$NaN` for the amount.
  4. Confirmed via direct `fetch()` in-page: `GET /api/v1/agentbook-tax/reports/category-breakdown?startDate=2026-01-01&endDate=2026-07-01` returns **HTTP 503** `{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Plugin service agentbook-tax is unavailable"}}` — reproduced 3x, consistently.
  5. Same session, same moment: sibling endpoints in the identical plugin/namespace succeed — `GET /api/v1/agentbook-tax/cashflow/projection` → 200, `GET /api/v1/agentbook-tax/reports/pnl` → 200 with valid data. Rules out a general agentbook-tax outage; the failure is specific to the `reports/category-breakdown` route.
  6. Separately, `GET /api/v1/agentbook-expense/vendors` returns 200 with valid `transactionCount` per vendor but no dollar-amount field in the payload — the frontend's `avg $NaN` / `$NaN` on the Top Vendors list is a distinct bug (frontend expects an amount field the vendors endpoint doesn't return).
- **Expected:** Category Breakdown shows the real YTD total and category split; Top Vendors shows real dollar amounts.
- **Actual:** Category Breakdown is always $0 (backend 503 on that one route); Top Vendors amounts are always `$NaN` (frontend/backend contract mismatch on the vendors payload shape).
- **Evidence:** Direct fetch results captured above; screenshots not captured (text-based Playwright run) — reproducible via the same 3 fetch calls against prod.
- **sibling_check:** Ran — checked whether other `reports/*` and `cashflow/*` routes in the same plugin are affected. Result: **not a plugin-wide outage** — `reports/pnl`, `reports/balance-sheet`, `reports/cashflow`, `reports/trial-balance`, and `cashflow/projection` all return 200 in the same session. Only `reports/category-breakdown` 503s. This is a single broken route, most likely a missing/crashing handler or a route-registration gap specific to that path — needs a backend code-level look (out of scope for this QA pass; flagging for dev triage, not fixing).

---

### QA-P3-002

- **Severity:** High
- **Taxonomy:** #7 Error-state gap
- **Surface:** `/agentbook/reports` (Financial Reports — Tax plugin, ◐ spot-check inventory item; this is also the "Exports spot-check" item from the task list)
- **Repro steps:**
  1. Log in as Maya, navigate to `/agentbook/reports`.
  2. Click "Profit & Loss" card.
  3. Confirm via network trace: `GET /api/v1/agentbook-tax/reports/pnl` fires and returns 200 with real P&L data (revenue $11,550.00 as Service Revenue, expense lines, etc.)
  4. Observe the page: no visible change. No modal, no navigation, no inline render, no download.
  5. Repeated for "Balance Sheet," "Cash Flow," and "Trial Balance" cards — **all 4** report types show the identical pattern: API call fires and returns 200, page content is byte-identical before/after (`CONTENT_CHANGED: false` confirmed programmatically for all 4).
- **Expected:** Clicking a report card renders the report (inline, in a modal, in a new view, or triggers a file download) — some visible outcome using the data that was just fetched.
- **Actual:** Data is fetched successfully every time but never rendered anywhere. From a user's perspective, clicking does nothing — a silent no-op that looks like a broken button.
- **Evidence:** Network capture logs (`200 .../reports/pnl`, `200 .../reports/balance-sheet`, `200 .../reports/cashflow`, `200 .../reports/trial-balance`); before/after `body.innerText()` diff confirmed unchanged for all 4.
- **sibling_check:** Ran — this is itself the sibling check (checked all 4 report types on the same page, not just P&L). Result: **all 4 affected identically** — this is a page-level rendering bug (the click handler fetches but the fetched data has nowhere to go), not a per-report-type issue. High severity per the decision rule: there is no workaround at all to view a report through this page — a real regression risk for the "Exports spot-check" item in Phase 3's checklist, and it directly undercuts the "tax report renders without error" bar the task asked to confirm.

---

### QA-P3-003

- **Severity:** Medium
- **Taxonomy:** #7 Error-state gap
- **Surface:** `/agentbook/cashflow` (CashFlow — Tax plugin, ◐ spot-check item)
- **Repro steps:**
  1. Log in as Maya, navigate to `/agentbook/cashflow`.
  2. Observe "CURRENT CASH BALANCE" renders as **`$NaN`**.
  3. Confirmed via network trace: `GET /api/v1/agentbook-tax/cashflow/projection` returns 200 with a valid `currentCashCents: 2027208` (i.e., $20,272.08) in the payload.
- **Expected:** "Current Cash Balance" shows $20,272.08 (or whatever the correct formatted figure is).
- **Actual:** Renders `$NaN` — the backend value is correct; this is a pure frontend formatting/parsing bug (likely reading the wrong field name, or dividing/formatting a value that isn't where the component expects it).
- **Evidence:** API response body captured: `{"success":true,"data":{"asOfDate":"2026-07-01T21:48:40.451Z","currentCashCents":2027208,"outstandingInvoices":[...]}}`; rendered page text captured showing `CURRENT CASH BALANCE / $NaN`.
- **sibling_check:** N/A for definition-mismatch (this is a rendering bug, not a divergent-implementation bug) — but noted as the same `$NaN` *symptom* as QA-P3-001's Top Vendors list. Worth a single dev pass across both since the fix pattern (frontend reading a missing/mis-named amount field) may be shared. Downgraded from High to Medium under the decision rule because the same figure is available correctly elsewhere (Tax Dashboard's "Net Income," Reports P&L) — a workaround exists, just not on this specific page.

---

### QA-P3-004

- **Severity:** High
- **Taxonomy:** #8 Coverage gap (real surface exists in code, but resolves to the wrong plugin bundle in production)
- **Surface:** `/agentbook/mileage` (Mileage — Expense plugin, ◐ spot-check item; explicitly called out in the task as "not in middleware map — verify actual paths")
- **Repro steps:**
  1. Log in as Maya, navigate directly to `/agentbook/mileage`.
  2. Page loads (HTTP 200, no 404), nav breadcrumb/title says "Mileage."
  3. Body content, however, is the Core plugin's Dashboard/chat widget — the agent chat panel with unrelated conversation history ("You have $2069.98 in uncategorized expenses...", proactive alerts, etc.), not the Mileage page's log/export UI.
  4. Confirmed via `document.querySelectorAll('h1,h2')` → `["Mileage", "AgentBook"]` — "Mileage" is the nav-shell heading; "AgentBook" is the Dashboard chat widget's own heading, rendering in the content area where the Mileage page should be.
  5. Root cause confirmed in `apps/web-next/src/middleware.ts`: `PLUGIN_ROUTE_MAP` has no entry for `/agentbook/mileage`, so it falls through to the `/agentbook` catch-all which maps to `agentbookCore` (Dashboard) rather than `agentbookExpense` (which owns the actual `MileagePage` component, confirmed present in `plugins/agentbook-expense/frontend/src/App.tsx` with its own `/mileage` route and `/agentbook/mileage` in that plugin's own path list).
  6. Practical effect: no mileage log is visible, no "Log trip"/export button is reachable via direct navigation to this URL — the real Mileage feature is unreachable through its own canonical path.
- **Expected:** `/agentbook/mileage` loads the Expense plugin's Mileage page (trip log + export button), matching every sibling expense route (`/agentbook/bills`, `/agentbook/vendors`, `/agentbook/bank`, `/agentbook/per-diem`, `/agentbook/budgets`, `/agentbook/receipts` — all of which DO have explicit `PLUGIN_ROUTE_MAP` entries and correctly loaded the right plugin content in this pass).
- **Actual:** Loads the wrong plugin bundle (Core/Dashboard) silently — no error, no 404, just the wrong page's content under the right nav label.
- **Evidence:** `apps/web-next/src/middleware.ts` — `PLUGIN_ROUTE_MAP` (lines ~11-36) lists `/agentbook/bills`... `/agentbook/per-diem` explicitly but has no `/agentbook/mileage` entry before the generic `/agentbook` → `agentbookCore` fallback. Compare to `plugins/agentbook-expense/frontend/src/App.tsx` lines ~24, 41, 62-63 which register `/mileage` and list `/agentbook/mileage`, `/agentbook/mileage/*` as paths that plugin expects to own.
- **sibling_check:** Ran — checked every other Expense-plugin route against `PLUGIN_ROUTE_MAP`. Result: **Mileage is the only expense sub-page missing its entry.** Bills, Vendors, Bank, PerDiem, Budgets, Receipts, Expenses all have explicit map entries and rendered correctly in this pass. This is a one-off omission, not a systemic pattern — a one-line middleware fix (add `'/agentbook/mileage': 'agentbookExpense'` before the generic `/agentbook` catch-all) would resolve it, but per QA-tester scope this is reported, not fixed.

---

### QA-P3-005

- **Severity:** High (upgraded from initial Medium once sibling_check confirmed root cause and blast radius)
- **Taxonomy:** #1 Definition mismatch
- **Surface:** `/agentbook/expenses` "This Year" filter vs. agent-brain `query-expenses` skill (web chat) — plus 4 further sibling call sites found to share the same gap
- **Repro steps:**
  1. Log in as Maya. Navigate to `/agentbook/expenses`. Default filter is "This Year" (confirmed via `bg-primary` active class on the filter pill — this is the default `period` state, not an artifact of test setup).
  2. Header reads **"27 expenses · $9,114.93."**
  3. On the same account, in the same session, ask the web chatbot (via the Dashboard's chat panel): *"how many expenses do I have this year and what is the total"*
  4. Chatbot (via `query-expenses` skill) answers: **"You have 31 expenses totaling $12,398.91 this year so far."**
  5. Both claim to represent the same concept — Maya's expenses "this year" (Jan 1, 2026 – Jul 1, 2026) — for the same tenant, same moment. They disagree by 4 expenses and ~$3,284.
  6. Cross-checked the Expenses page's own "All Time" filter (33 expenses · $12,633.91) — neither the page's This Year (27/$9,114.93) nor All Time (33/$12,633.91) figure matches the chatbot's This Year figure (31/$12,398.91) exactly, confirming this isn't a simple date-boundary artifact.
- **Expected:** The Expenses page and the chatbot should compute "this year" identically for the same tenant — same status filters (deleted/personal/draft inclusion), same date field, same boundary handling.
- **Actual:** Three different totals for what should be at most two distinct, well-defined windows (This Year vs All Time); the chatbot's number matches neither page figure.
- **Evidence:** Page header "27 expenses · $9,114.93" (This Year, default), "33 expenses · $12,633.91" (All Time, after explicit click); chatbot text "You have 31 expenses totaling $12,398.91 this year so far." with the `query-expenses` skill tag visible in the UI.
- **sibling_check:** **Ran to completion via a dedicated research subagent.** Root cause confirmed with file:line precision:
  - **`plugins/agentbook-core/backend/src/server.ts:4227-4236`** (the `query-expenses` inline handler) queries `AbExpense` with `{ tenantId, isPersonal: false, date: { gte: startDate, lte: endDate } }` — **missing the `deletedAt: null` soft-delete filter** that every other "this year"-style query applies. It also hardcodes `isPersonal: false` (business-only), while the Expenses page's default filter is `'all'` (business + personal).
  - **`apps/web-next/src/app/api/v1/agentbook-expense/expenses/route.ts:234-255`** (the Expenses page's backend) correctly applies `withSoftDelete()` (i.e. `deletedAt: null` unless `includeDeleted=true` is explicitly requested) and an optional `isPersonal` filter only when the user picks Business/Personal — this is the correct reference implementation.
  - Net effect: the chatbot's query includes soft-deleted expenses (biases count up) while excluding personal expenses (biases count down); the soft-delete inclusion appears to be the dominant factor given the chatbot's total is higher, not lower, than the page's This-Year figure.
  - **Four further sibling sites share the identical gap** (no `deletedAt` filter): the dead-code twin `advisor/ask/route.ts:93-97`; `category-summary/route.ts:45-48,113-120`; `agentbook-tax/reports/annual-summary/route.ts:27-29`; and query-finance's `server.ts:1240-1253`. None of these filter `status` either (neither does the correct reference implementation, so that's not the proximate cause here, but is a latent risk).
  - The agent also found and flagged the **correct reference pattern already in the codebase** for comparison: `server.ts:3769-3770` (the categorize-expenses handler, i.e. the actual PR #176 fix) uses `{ tenantId, deletedAt: null, status: 'confirmed', categoryId: null }` — proving the omission in `query-expenses` and its four siblings is an oversight, not an intentional design choice, and confirming this is the same bug class recurring in five more places after PR #176 fixed it in one.
  - Separately noted (latent, not the proximate cause of the 27-vs-31 gap, but worth a line item of its own): the Expenses page's frontend computes its displayed count/total via a **client-side JS reduce over a 200-row-capped fetch**, discarding the backend's own accurate DB-native `count()` — a correctness risk for any tenant with >200 matching expenses, independent of this finding.
- **Severity note:** Upgraded to High. This is not an isolated one-off — it is the same root-cause bug class as PR #176, now confirmed present in **5 separate query sites** across the agent-brain and reports code, with a known-correct reference implementation sitting right next to the broken ones in the same file. Per the plan's decision rule, a workaround exists (the Expenses page itself is accurate) so the strict letter of "no completion path at all" isn't met — but the plan's own closure workflow (§4) says a definition-mismatch finding isn't closed until siblings are "either fixed too or separately logged," and 4 of the 5 siblings are unlogged elsewhere; treating as High to ensure this doesn't slip to backlog before the pattern is fixed everywhere PR #176 didn't reach.

---

### QA-P3-006 (observation, not a formal finding — flagged for Phase 4 owner)

- **Severity:** N/A — out of Phase 3's scope (chatbot conversational quality is Phase 4's mandate), noted here because it was encountered incidentally during Phase 3's Tax-page click-through.
- **Taxonomy:** #1 Definition mismatch / cross-plugin routing
- **Surface:** Web chat, `query-expenses`/expense-recording skill vs. invoice-creation skill
- **Repro steps:** Typed "send an invoice to Acme for $500" and, separately, "I need to invoice Acme Corp $500 for consulting" into the web chat panel. Both times got: **"I couldn't record that expense. Please try again."** — reproduced twice, on two different page contexts (Dashboard and Mileage's leaked chat panel). By contrast, "create an invoice for Acme for $500" correctly triggered an invoice-creation plan ("Here's my plan: 1. Create an invoice for Acme for $500...").
- **Expected:** "send an invoice..." and "I need to invoice..." should route to the invoice-creation skill, same as "create an invoice...".
- **Actual:** They fall through to the expense-recording skill's generic failure message, which is doubly wrong: wrong skill, and the error message ("couldn't record that expense") actively mismatches the user's actual request (an invoice, not an expense).
- **Not logged as a formal Phase 3 finding** because chatbot routing quality is explicitly Phase 4's rubric (actionability, skill routing) — but flagging now since it's a concrete, reproduced miss on the exact "Cross-plugin task" row the plan's Phase 4 use-case matrix calls out ("send an invoice to Acme for $500" is literally the example prompt listed in the plan's matrix). Recommend Phase 4 pick this up first.

---

## Phase 3 coverage ledger (what was full-depth vs. spot-check-only, per the plan's honesty principle)

| Area | Depth | Notes |
|---|---|---|
| Dashboard, Ledger, Activity, Agents | Full click-through, rendered content read | Dashboard numbers cross-checked against Ledger/Expenses; internally plausible except the This-Year mismatch (QA-P3-005) |
| Accounts, Onboarding, Projections, SavedSearches, SkillMetrics, TelegramSettings, HomeOffice | Load-check only (per plan's ◐ spot-check designation) | All returned 200, no error-boundary text, plausible content in the snippet captured. Not clicked into further. |
| Expenses list/filter | Full — filters exercised, uncategorized banner cross-checked against Agent Insights panel, both agree (4 uncategorized) | Categorization-row interaction attempted; no accessible "click to categorize" affordance was found via badge search (page uses inline dropdowns per row, not a clickable badge — see below) |
| Bills, Vendors, BankReview/BankConnection, PerDiem, Mileage, Budgets, Receipts | Load-check + content read | Mileage found broken (QA-P3-004); Bills/Vendors/Bank/PerDiem/Budgets/Receipts all rendered sensible, internally-consistent content |
| Invoice list, New Invoice form | Full — opened the New Invoice form, confirmed Save as Draft / Create & Send buttons present. Did not actually submit/send (per instructions to avoid spending real money — though invoicing has no real money movement, erred conservative and did not create a stray real invoice in Maya's account) | Send/mark-paid steps not exercised end-to-end |
| Clients, Estimates, Projects, Timer, RecurringInvoices | Load-check only | All returned 200; RecurringInvoices correctly showed empty state (0/0/0/0/0) — plausible, no recurring invoices seeded |
| Tax Dashboard ↔ Tax Package nav (PR #175 regression check) | Full — asserted rendered content both directions, not just URL | **Confirmed fixed**: "Year-end Package" button present on Tax Package tab, absent after navigating back to Dashboard tab. This is the exact assertion style the plan requires (content-based, not URL-based) |
| Quarterly, Deductions, CashFlow, Analytics, WhatIf, Reports (direct nav, non-tab surfaces) | Load-check + content read | CashFlow (QA-P3-003) and Analytics (QA-P3-001) found broken; Quarterly, Deductions, WhatIf rendered plausible content; Reports found broken at the interaction level (QA-P3-002) |
| Dashboard-level pages: accountant, feedback, governance, personal, releases, treasury, teams | Load-check + content read (not deep interaction) | All 200, no error text. `governance` and `treasury` are explicitly-labeled placeholders ("This is a placeholder for the embedded governance/treasury view") — not bugs, by design per the rendered copy itself, but worth flagging to product as pre-launch placeholder content still live if that's not intended for this launch. `feedback` shows all-zero counts (plausible for a fresh feedback board). `accountant`, `personal`, `releases`, `teams` all show real, sensible primary actions (share-with-CPA link, net worth figure, release notes, create-team CTA). |
| Payroll (`/payroll`) | Load-check + content read | Loads with 3 real seeded employees, pay run counts, "Run payroll" CTA — sensible entry point even though this QA pass didn't execute a payroll run |
| Second app shell (`/app`, `/app/capture`, `/app/chat`, `/app/docs`) | Load-check + content read, no deep interaction (e.g. did not attempt an actual photo capture) | All 4 load with real, distinct content (YTD figures on `/app`, a photo-capture UI on `/app/capture`, a chat box on `/app/chat`, a real document list on `/app/docs`) — appears to be a deliberate, functioning alternate/mobile-oriented UI, not dead code. Recommend Phase-owner decide explicitly whether to keep both shells live for launch; not flagging as a bug since it works, but flagging the plan's own open question ("deliberate alternate UI or dead/legacy") as answered "deliberate and working" based on this pass, not exhaustively verified beyond load + spot content check. |
| Exports spot-check: tax reports, mileage export, CSV import (Bank) | Full for what could be tested | Tax reports: broken (QA-P3-002). Mileage export: **could not test** — the export button itself is unreachable because the page never loads (QA-P3-004) — this is a downstream consequence of QA-P3-004, not a separate finding. Bank/CSV import screen loads correctly with a clear "Connect with Plaid" CTA and sandbox credentials hint; did not exercise an actual Plaid sandbox connection in this pass (out of scope for this session; noted, not executed). |
| PWA manifest | Single unauthenticated spot-check only (this is Phase 5's mandate, not Phase 3's) | `GET /manifest.json` returns 200 with valid-looking JSON (name, theme_color matching brand teal `#149578`). Not a substitute for Phase 5's full PWA check. |

---

## Phase 3 verdict

Phase 3's click-through surfaced five confirmed, reproducible bugs and one out-of-scope observation flagged forward to Phase 4. Four of the five (Analytics' 503 on category-breakdown, the Reports page's silent no-op across all 4 report types, Mileage resolving to the wrong plugin bundle, and the Expenses-page-vs-chatbot "this year" total mismatch) are High severity under the plan's decision rule and closure workflow — the first three leave the user with zero completion path for a real, in-inventory feature (viewing expense analytics, viewing/exporting any financial report, or logging/exporting mileage), and the fourth is High because its now-completed sibling_check found the identical missing-`deletedAt`-filter bug in five separate query sites (the `query-expenses` chatbot skill plus four more: a dead-code twin, category-summary, tax annual-summary, and query-finance), the same bug class PR #176 fixed in only one place (categorize-expenses). The CashFlow `$NaN` is Medium (a workaround exists via the Tax Dashboard's own net-income figure). Everything else exercised in this pass — the Tax Dashboard↔Tax Package bidirectional nav fix from PR #175, the uncategorized-expense count (now cross-checked across the Expenses page banner and its own Agent Insights panel, which agree at 4/$2,069.98), the invoice creation form, Bills/Vendors/Bank/PerDiem/Budgets/Receipts, and the seven dashboard-level pages previously missing from earlier audit passes — rendered correctly with plausible, internally consistent content. Coverage was genuinely full-depth (clicked, read rendered content, cross-checked numbers, and in QA-P3-005's case ran a full code-level sibling_check to file:line precision) for Core, Expenses, the Tax nav-regression check, and the report-click interaction bugs; it was load-check-only, as the plan's own ◐ designation anticipates, for the long tail of secondary plugin pages (Accounts, Onboarding, Projections, SavedSearches, SkillMetrics, TelegramSettings, HomeOffice, Clients, Estimates, Projects, Timer, RecurringInvoices) — those are confirmed not to 404 or error-boundary but were not clicked into further. No code was changed in this pass, per QA-tester scope; all six items above need dev triage before launch, with the four High items blocking per the plan's launch-gate rubric.

---

## Phase 5 — Cross-cutting quality (accessibility, mobile, performance, error states, cross-browser, PWA)

Executed via Playwright against production (`https://agentbook.brainliber.com`), logged in as `maya@agentbook.test`. Throwaway specs: `tests/e2e/qa-audit-phase5.spec.ts` and `tests/e2e/qa-audit-phase5-webkit.spec.ts` (deleted after this pass per instructions — findings below are the durable artifact). WebKit was not preinstalled in this environment but was installed successfully via `npx playwright install webkit` (77.5 MiB download), so the cross-browser pass is real, not a noted gap.

---

### QA-P5-001

- **Severity:** High
- **Taxonomy:** #6 Accessibility/mobile/cross-browser gap
- **Surface:** Left sidebar navigation on every `(dashboard)` route at 375px width — confirmed on `/agentbook`, `/agentbook/expenses`, `/agentbook/tax`
- **Repro steps:**
  1. Set viewport to 375×812 (iPhone SE-ish), log in as Maya, navigate to `/agentbook`.
  2. Observe the desktop sidebar (nav links: Core, Expenses, Invoicing, Tax & Reports, Bills, Payroll, Personal finance, Accountant) renders at full width, unchanged from desktop, consuming roughly the left half of the 375px screen.
  3. The remaining content column is squeezed to ~135px wide, causing page titles to truncate to 3-4 characters ("Age…", "Expe…", "Tax") and dollar figures to wrap mid-number (e.g. "$284" splits across two lines as "$2" / "84").
  4. Repeated on `/agentbook/expenses` and `/agentbook/tax` — identical layout collapse on both.
  5. Confirmed via source read (research agent) that this is not a broken breakpoint but the absence of one: `apps/web-next/src/components/layout/sidebar.tsx`, `apps/web-next/src/components/layout/app-layout.tsx`, and `apps/web-next/src/contexts/shell-context.tsx` contain **no** `matchMedia`/`useMediaQuery`/responsive Tailwind modifier (`sm:`/`md:`/`lg:`) governing sidebar width or visibility. `AppLayout` sets `paddingLeft: actualWidth` (240px open / 52px collapsed) as an unconditional inline style; `isSidebarOpen` initializes from `localStorage` defaulting to `true` with zero viewport awareness. The "Collapse" button in the accessibility tree is a manual desktop-only 240px↔52px toggle, not a mobile drawer/hamburger pattern.
- **Expected:** Below some breakpoint (e.g. 768px), the sidebar collapses to an off-canvas drawer behind a hamburger trigger, or defaults to hidden, leaving the full viewport width for page content.
- **Actual:** The sidebar renders identically to desktop on every dashboard page regardless of viewport, and there is no code path that would ever change that.
- **Evidence:** Screenshots `/tmp/qa-phase5-mobile-dashboard.png`, `/tmp/qa-phase5-mobile-expense-list.png`, `/tmp/qa-phase5-mobile-tax-dashboard.png` — all show the identical squeeze. Landing page and `/login` (both outside the dashboard shell) render cleanly at the same viewport with no overflow, confirming the bug is scoped to the dashboard shell specifically, not a global mobile CSS issue.
- **sibling_check:** Ran — grepped `apps/web-next/src/components/layout/` for other `paddingLeft`/fixed-width layout logic. Result: `app-layout.tsx` is the only file with this hardcoded padding; there is no second, differently-broken sidebar implementation elsewhere in the app to separately log. This is a single shared shell component used by all `(dashboard)` routes, so the fix (once made) fixes every affected page at once — but conversely, every dashboard-area page is affected today, not just the three sampled.

---

### QA-P5-002

- **Severity:** Medium
- **Taxonomy:** #7 Error-state gap
- **Surface:** Add-expense form, `/agentbook/expenses/new` (`plugins/agentbook-expense/frontend/src/pages/NewExpense.tsx`)
- **Repro steps:**
  1. Log in as Maya, navigate to `/agentbook/expenses/new`.
  2. Intercept `POST /api/v1/agentbook-expense/expenses` via `page.route(...)` and force `route.abort('failed')`.
  3. Fill Amount=99.99, Vendor="QA Error Test", click "Record Expense."
  4. Observe: the button returns to its normal enabled "Record Expense" state (does not hang), but no error text, toast, or any visual indicator appears anywhere on the page — confirmed via full-body `innerText()` scan (`hasErrorTextOnPage=false`) and a follow-up screenshot.
  5. Confirmed via source read: `handleSubmit`'s `catch (err) { console.error(err); }` (NewExpense.tsx, in the submit handler) only logs to the browser console — there is no `setError`/toast call in this catch block at all, unlike the sibling invoice-send handler (see QA-P5-003) which at least attempts a toast.
- **Expected:** A failed save shows a clear, human-readable error (e.g. "Couldn't save this expense — check your connection and try again") so the user knows to retry, and doesn't wonder whether the expense actually saved.
- **Actual:** Complete silence. A user would have no way to know the save failed short of checking the Expenses list afterward to see it's missing.
- **Evidence:** Screenshot `/tmp/qa-phase5-error-expense.png` (form still showing filled fields, no error banner); source: `plugins/agentbook-expense/frontend/src/pages/NewExpense.tsx` `handleSubmit` catch block.
- **sibling_check:** Ran — compared against the invoice-send handler (`InvoiceDetail.tsx`), which does call `showToast(String(e), 'error')` on failure (see QA-P5-003 for that finding's own, different problem). Result: **not the same implementation, and not equally bad** — the expense form's failure handling is strictly worse (zero user feedback vs. a badly-worded-but-present toast). Recommend checking other expense-plugin forms (Bills, Vendors edit flows) for the same silent-catch pattern as a follow-up, not done in this pass.

---

### QA-P5-003

- **Severity:** Medium
- **Taxonomy:** #7 Error-state gap
- **Surface:** Invoice detail "Send Invoice" action, `/agentbook/invoices/:id` (`plugins/agentbook-invoice/frontend/src/pages/InvoiceDetail.tsx`, `doSend()`)
- **Repro steps:**
  1. Log in as Maya, navigate to `/agentbook/invoices`, open draft invoice INV-2026-0011 (StartupXYZ, $6,000.00).
  2. Intercept `POST /api/v1/agentbook-invoice/invoices/:id/send` via `page.route(...)` and force `route.abort('failed')`.
  3. Click "Send Invoice."
  4. A toast does appear (source: `doSend()`'s `catch (e) { showToast(String(e), 'error'); }`), but polling confirmed it renders the literal string **`TypeError: Failed to fetch`** — the raw JavaScript exception text, not a human-readable message — and it fades after ~3.5s (`setTimeout(() => setToast(null), 3500)` in the component).
  5. An earlier test pass that checked page text 4 seconds after the click (i.e., after the toast had already faded) found `hasErrorTextOnPage=false`, which understates the bug: the real issue isn't silence, it's that the message shown, however briefly, is developer-facing jargon.
- **Expected:** On send failure, a toast reading something like "Couldn't send this invoice — try again" — informative, human-readable, and ideally not gone within 3.5 seconds for a failure a user might want to actually read and act on.
- **Actual:** Shows `TypeError: Failed to fetch` (or similar raw exception text for other failure modes, since `showToast(String(e), 'error')` stringifies whatever error object was thrown) for 3.5 seconds, then disappears with no persistent indicator that the send failed.
- **Evidence:** Console-timed poll captured `T+300ms hasErrorText=true` with body snippet containing `TypeError: Failed to fetch`; screenshot `/tmp/qa-phase5-error-invoice.png` (captured post-fade, showing no visible error, illustrating how easy this is to miss even for a QA pass without precise timing).
- **sibling_check:** Ran — grepped `InvoiceDetail.tsx` for all `showToast(String(e), 'error')` call sites: `doSend()` (line 102), `doVoid()` (line 115), and the reminder-send handler (line 127) all share the identical pattern — raw exception stringification, no message translation layer. **Confirmed systemic within this file**: fixing one without the other two would leave the pattern in place for void and remind. Not yet checked outside `InvoiceDetail.tsx`.

---

### QA-P5-004

- **Severity:** Medium
- **Taxonomy:** #7 Error-state gap, #4 Stale-data-presented-as-live (adjacent)
- **Surface:** Main dashboard Core plugin panel (Sessions list + AgentBook chat widget), `/agentbook`
- **Repro steps:**
  1. Log in as Maya. Intercept all `GET /api/v1/agentbook-core/**` requests and force `route.abort('failed')` (this hits, among others, `events/since` and `threads`, confirmed via the interception log).
  2. Navigate to `/agentbook`.
  3. Observe: no error banner, no "couldn't load" message, no spinner stuck spinning (`visibleSpinnerElements=0`) — the page instead renders a normal-looking empty state: "SESSIONS / No sessions yet." and the chat widget's default "Hi! Try: …" placeholder greeting.
  4. This is visually indistinguishable from the *true* empty state a genuinely new user with zero session history would see.
- **Expected:** A distinguishable "couldn't load your sessions" error state, separate from the legitimate empty state, so a user with real history isn't misled into thinking they have none.
- **Actual:** The failure degrades into what looks like normal empty-state copy, with no indication anything went wrong.
- **Evidence:** Screenshot `/tmp/qa-phase5-error-dashboard.png`; intercepted request log confirms both `events/since` and `threads` GETs were aborted, yet the rendered page shows no error affordance.
- **sibling_check:** N/A — not a definition-mismatch or non-actionable-response finding; this is an error-state gap specific to how the Core dashboard panel handles a failed initial data fetch. Not checked against other panels' loading/empty-state handling in this pass (would require a similar abort-and-observe pass per panel; out of scope for this session).

---

### QA-P5-005

- **Severity:** Low
- **Taxonomy:** #6 Accessibility/mobile gap
- **Surface:** Global — icon-only buttons across the dashboard shell
- **Repro steps:** On `/agentbook`, ran a DOM query for `button`/`a[role="button"]` elements containing only an `<svg>` child with no text, `aria-label`, or `title`. Found 1 such element (a 22×22px icon button near the top of the sidebar/session panel, exact function not identified from the DOM alone).
- **Expected:** Every icon-only interactive element has an `aria-label` describing its action.
- **Actual:** One icon-only button has no accessible name; a screen-reader user would hear only "button" with no indication of its purpose.
- **Evidence:** `ICON_ONLY_NO_LABEL_COUNT: 1`, outerHTML sample: `<button class="text-muted-foreground hover:text-foreground"><svg ...></button>`.
- **sibling_check:** Ran as part of the same query (the query itself is the sibling sweep across the whole dashboard DOM tree). Result: **only one occurrence found** on the pages sampled (main dashboard) — not a systemic pattern on this page. Not re-run on Expenses/Tax pages; those may have their own icon-only buttons not sampled in this pass.

---

### QA-P5-006

- **Severity:** Low (informational — no code defect, but a real launch-readiness gap worth a decision)
- **Taxonomy:** #6 Accessibility/mobile/cross-browser gap (PWA sub-item)
- **Surface:** `<link rel="manifest">` — checked on `/` (landing) and `/app` (the PWA-oriented second app shell, whose `manifest.json` declares `start_url: "/app"`)
- **Repro steps:**
  1. `GET /manifest.json` directly → 200, valid JSON, all expected fields present (`name`, `short_name`, `icons` with 2 entries, `start_url: "/app"`, `theme_color: "#149578"` matching brand teal, `shortcuts` for capture/chat/docs).
  2. `GET /sw.js` directly → 200, `content-type: application/javascript`, 3933 bytes, contains real service-worker code (`addEventListener`, `caches.*`).
  3. Loaded `/` and `/app` in a real browser context and queried `document.querySelector('link[rel="manifest"]')` on both → `null` on both.
  4. Confirmed via source read: no `apps/web-next/src/app/layout.tsx` (root) or `apps/web-next/src/app/app/layout.tsx` (the `/app` shell layout) references `manifest.json` at all; `grep` across `apps/web-next/src` for `rel.*manifest` or `manifest.json` in `.tsx`/`.ts` files returns zero component-level hits (only plugin-registry code that manages a *different*, unrelated `manifest.json` per plugin bundle).
  5. Service-worker *registration* (`register-sw.ts`) is wired into `/app`'s layout, so `navigator.serviceWorker.register()` likely still fires there — but without the `<link rel="manifest">` tag, browsers have no signal to offer "Add to Home Screen"/install prompts, which is the actual point of having a manifest.
- **Expected:** Either `/app` (the PWA-scoped shell, per its own `start_url`) links the manifest so install prompts work, or a documented decision that PWA installability is out of scope for this launch.
- **Actual:** The manifest and service worker are both correctly built and served, but nothing in the app actually links to the manifest, so the PWA is not installable today despite all its underlying assets existing and working.
- **Evidence:** `MANIFEST_STATUS: 200`, `MANIFEST_VALID_JSON: true`, full manifest JSON captured (all fields present); `SW_STATUS: 200`, `SW_LOOKS_LIKE_JS: true`; `MANIFEST_LINK_TAG_HREF(/): null`, `MANIFEST_LINK_TAG_HREF(/app): null`.
- **sibling_check:** Ran — grepped all of `apps/web-next/src` for any `rel="manifest"` reference. Result: **zero occurrences anywhere in the app**, confirming this isn't a per-page gap but a total absence — there's no page that currently links it, so there's no "some pages have it, some don't" pattern to reconcile, just a single missing tag to add (to `/app/layout.tsx` at minimum, per the manifest's own `start_url`).
- **Note (per plan, explicitly out of scope):** Full push-notification delivery testing was not attempted in this pass, as directed by the plan.

---

### Non-findings — checked and passed clean

- **Landing page mobile (375px):** No horizontal overflow, no overlapping elements, text fully readable, screenshot confirms a clean single-column responsive layout distinct from the dashboard shell's problem. (`/tmp/qa-phase5-mobile-landing.png`)
- **Login page mobile (375px):** Clean, no overflow; all fields/buttons reasonably sized (email/password inputs full-width, submit button 343×40).
- **Keyboard-only login:** Tab order is logical (email → password → submit → forgot-password link → Google OAuth → sign-up link); completing login with Tab + typed credentials + Enter succeeded (`KEYBOARD_LOGIN_RESULT: SUCCESS`).
- **Dashboard keyboard navigation:** 25 sequential Tabs traversed sidebar nav, session list, and chat widget without ever getting stuck off-page (`STUCK_ON_BODY_COUNT: 1` out of 25, and that one occurrence was the natural end-of-page wraparound back to the top, not a trap). All primary nav links/buttons have real accessible names — zero unnamed interactive elements found in the aria snapshot.
- **Add-expense keyboard flow:** Amount → Vendor → Tab chain confirmed to move focus in the expected visual order, and the submit button is reachable via Tab alone.
- **Performance:** Landing (`wallClockLoad=226ms`), login (`206ms`), and the authenticated dashboard (`167ms` wall clock / `149ms` load event) all loaded roughly two orders of magnitude under the plan's 3-second flag threshold. No performance findings — this app is fast on a good connection from this test environment; note that this doesn't rule out slower real-world networks, which weren't simulated.
- **Cross-browser (WebKit):** Login and dashboard both work correctly in WebKit — login succeeds, dashboard renders full real content (sidebar, sessions, chat history), zero console errors. Screenshot (`/tmp/qa-phase5-webkit-dashboard.png`) is visually consistent with the Chromium render. No WebKit-specific defects found on this pass's two-page scope.
- **Color contrast, brand teal:** See QA-P5-007 below — this one did NOT pass clean and is logged as a finding, not listed here; included in this list only to note it was the one contrast check that failed.

---

### QA-P5-007

- **Severity:** Medium
- **Taxonomy:** #6 Accessibility/mobile/cross-browser gap
- **Surface:** Brand teal (`#149578`) and its gradient partner (`#62cda2`) as used for text/button-background color against white and dark backgrounds, computed via the WCAG relative-luminance contrast formula
- **Repro steps:** Computed contrast ratios directly from the hex values used in the plan's own brand-consistency spec (`#149578`, `#62cda2`) against `#ffffff` (white) and `#161c22` (the manifest's declared dark `background_color`):
  - `#149578` text/button on white → **3.75:1** — fails the 4.5:1 AA threshold for normal text; only passes AA for large text (≥18.66px bold or ≥24px regular, per the 3:1 large-text threshold).
  - `#149578` text on the dark background `#161c22` → **4.58:1** — passes AA for normal text.
  - `#62cda2` text/button on white → **1.95:1** — fails AA even for large text (needs ≥3:1).
  - `#62cda2` text on `#161c22` → **8.81:1** — passes comfortably.
- **Expected:** Brand teal used for body text or button labels against a white/light background should clear 4.5:1 for normal-size text, per the plan's own AA bar.
- **Actual:** The primary teal (`#149578`) is borderline-failing on white (3.75:1, large-text-only pass) and the lighter gradient teal (`#62cda2`) fails outright on white (1.95:1) — meaning if either of these colors is used for small text or a button label on a white/light card anywhere in the app (the gradient teal is visually similar to the accent color used on the landing page's "Invite now" link and pricing highlights, both on light-ish card backgrounds in places), it's a real AA violation, not just a theoretical one.
- **Evidence:** Computed ratios above (formula: WCAG relative luminance → contrast ratio; see spec for the sRGB-to-linear conversion used). This is an estimate via formula per the task's own instructions, not a full axe-core/Lighthouse audit — the plan explicitly scoped it this way.
- **sibling_check:** N/A — this is a color-math finding, not a definition-mismatch or non-actionable-response finding. Recommend a follow-up pass that greps actual rendered CSS/component usage for every place `#149578`/`#62cda2` (or their Tailwind/CSS-variable equivalents) are applied as *text or button-label* color specifically against a white/light background, to convert this from "the math says this combination is risky" to a list of concrete on-screen violations — not done in this pass (out of scope: this was a spot-check per the plan's own wording, "estimate via contrast-ratio formula... rather than a full audit").

---

## Phase 5 verdict

Phase 5 found one High-severity, launch-relevant defect and five Medium-severity gaps, plus one Low informational item and one Low accessibility nit. The High finding — the dashboard shell's sidebar has no mobile breakpoint at all (confirmed by source read across `sidebar.tsx`, `app-layout.tsx`, and `shell-context.tsx`: no `matchMedia`, no responsive Tailwind modifier, an unconditional inline `paddingLeft`) — makes every `(dashboard)` route (dashboard, expenses, tax, and by the same shared-component logic, every other dashboard page) genuinely hard to use on a real phone at 375px width, with page titles and dollar amounts visibly truncating; this is a core-workflow-on-mobile problem, not a cosmetic one, and per the plan's decision rule there's no workaround (a user can't "just tap something else" to get the sidebar out of the way — no toggle exists that's mobile-aware). The landing and login pages, by contrast, are genuinely mobile-clean with zero overflow. The three error-state findings (silent-failure on add-expense; a raw `TypeError` shown to users on invoice-send failure, fading in 3.5s; and a failed dashboard data fetch that looks identical to a legitimate empty state) share a common theme: this codebase's failure-handling ranges from "says nothing" to "says something, but the wrong audience's something" — none of the three failure paths tested left the user actively misled about *what to do next*, but none gave them a clear path either. Performance is not a concern (all three pages tested loaded in low hundreds of milliseconds); keyboard accessibility on login, the dashboard, and the add-expense form is solid (correct tab order, no traps, real accessible names on nearly everything); WebKit cross-browser support is confirmed working end-to-end for login and dashboard (this pass installed WebKit fresh — 77.5 MiB — rather than reporting it as an environment gap, since a real pass was feasible). The PWA finding is a genuine pre-launch gap worth a product decision (all underlying PWA assets — manifest, service worker — are built and serve correctly, but nothing links the manifest, so install prompts can't fire); push-notification delivery was explicitly not tested, per the plan's own scope note. The color-contrast finding is a real, if narrow, AA risk on the lighter brand-teal gradient color specifically, flagged as a formula-based estimate rather than a confirmed on-screen violation, per the plan's own "estimate via formula" scoping. No code was changed in this pass, per QA-tester scope. Recommend: the sidebar mobile-breakpoint gap (QA-P5-001) blocks or strongly should block launch if mobile web traffic is expected at all; the error-state and PWA-manifest-link findings are cheap, same-session-fixable Medium items per the plan's closure workflow; the contrast finding needs a follow-up grep-for-usage pass before it's actionable as anything more specific than "handle with care."
