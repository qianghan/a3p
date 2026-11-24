# AgentBook Key Workflows & Implementation Guide

## File Locations Quick Reference

### Backend (Express servers)
| Plugin | Server File | Port |
|--------|------------|------|
| Core | `plugins/agentbook-core/backend/src/server.ts` | 4050 |
| Expense | `plugins/agentbook-expense/backend/src/server.ts` | 4051 |
| Invoice | `plugins/agentbook-invoice/backend/src/server.ts` | 4052 |
| Tax | `plugins/agentbook-tax/backend/src/server.ts` | 4053 |

### Frontend (React UMD plugins)
| Plugin | Pages Directory | Build & Deploy |
|--------|----------------|----------------|
| Core | `plugins/agentbook-core/frontend/src/pages/` | `npm run build` → copy to `apps/web-next/public/cdn/plugins/agentbook-core/` |
| Expense | `plugins/agentbook-expense/frontend/src/pages/` | Same pattern |
| Invoice | `plugins/agentbook-invoice/frontend/src/pages/` | Same pattern |
| Tax | `plugins/agentbook-tax/frontend/src/pages/` | Same pattern |

### Key Infrastructure
| Component | Location |
|-----------|----------|
| Prisma schema | `packages/database/prisma/schema.prisma` |
| Telegram webhook | `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` |
| Telegram bot library | `packages/agentbook-telegram/src/bot.ts` |
| Cron jobs | `apps/web-next/src/app/api/v1/agentbook/cron/` |
| API proxy (generic) | `apps/web-next/src/app/api/v1/[plugin]/[...path]/route.ts` |
| API proxy (dedicated) | `apps/web-next/src/app/api/v1/agentbook/{core,expense,invoice,tax}/[...path]/route.ts` |
| Middleware (routing) | `apps/web-next/src/middleware.ts` — PLUGIN_ROUTE_MAP |
| Mobile PWA screens | `apps/web-next/src/app/app/` (`_lib/api.ts` client, `_kit/` primitives) |
| Mobile server composition | `apps/web-next/src/lib/mobile/` (home, alerts, upcoming, doc-mapper) |
| Mobile e2e + launch gates | `tests/e2e/mobile-app/` (`scorecard.ts` runs every gate) |
| Stripe price reconciliation | `agentbook/check-stripe-pricing-sync.ts` (read-only: code vs DB vs Stripe) |
| AGI features | `packages/agentbook-framework/src/agi/` |
| Proactive handlers | `packages/agentbook-framework/src/proactive-handlers/` |
| Skills | `packages/agentbook-framework/src/skills/` |
| Jurisdiction packs | `packages/agentbook-jurisdictions/src/` |

## Common Development Patterns

### Adding a new API endpoint
1. Add route in the plugin's `server.ts` (before `start()`)
2. Use `(req as any).tenantId` for tenant isolation
3. Wrap mutations in `db.$transaction()` for atomicity
4. Create `AbEvent` inside the transaction for audit trail
5. Return `{ success: true, data: ... }` or `{ success: false, error: '...' }`

### Adding a new frontend page
1. Create component in `plugins/<name>/frontend/src/pages/NewPage.tsx`
2. Add route in `plugins/<name>/frontend/src/App.tsx` (both `<Route>` and `routes[]`)
3. Add URL mapping in `getInitialRoute()` function
4. Add route to `plugins/<name>/plugin.json` frontend.routes
5. Add path to middleware PLUGIN_ROUTE_MAP in `apps/web-next/src/middleware.ts` (if new prefix)
6. Build: `npm run build` → copy UMD to `apps/web-next/public/cdn/plugins/`

### Adding a new Prisma model
1. Add model to `packages/database/prisma/schema.prisma` with `@@schema("plugin_agentbook_xxx")`
2. Run: `DATABASE_URL=... DATABASE_URL_UNPOOLED=... npx prisma db push --skip-generate`
3. Run: `DATABASE_URL=... DATABASE_URL_UNPOOLED=... npx prisma generate`
4. Restart affected backend(s)

### Using LLM (Gemini)
Each plugin has its own `callGemini(systemPrompt, userMessage, maxTokens)` function.
- Reads `AbLLMProviderConfig` from DB (provider, apiKey, model)
- Returns `string | null` (null = LLM unavailable)
- Always provide a template fallback — never show LLM errors to users
- Gemini API key: stored in DB via admin UI, not in env vars

### Telegram Integration
- Bot token in `apps/web-next/.env.local` as `TELEGRAM_BOT_TOKEN`
- Webhook: `POST /api/v1/agentbook/telegram/webhook`
- Chat ID → tenant mapping in `CHAT_TO_TENANT` object in webhook route
- `bot.init()` required before `handleUpdate()` in serverless
- Tunnel for local dev: `./agentbook/start-telegram.sh`

### Tenant Resolution (how user ID flows)
```
Web: login → cookie naap_auth_token → proxy reads session → sets x-tenant-id header
Telegram: chat.id → CHAT_TO_TENANT lookup → x-tenant-id header
API (direct): x-tenant-id header
Cookie override: ab-tenant cookie (for persona switching in dev)
```

### Expense Creation with Journal Entry
When creating an expense that should hit the books:
1. Find or create vendor (`abVendor.upsert` by normalized name)
2. Look up category from `AbPattern` (vendor pattern learning)
3. If category found + not personal: create `AbJournalEntry` (DR expense account, CR cash 1000)
4. Create `AbExpense` with `journalEntryId`, `categoryId`, `status: 'confirmed'`
5. If low confidence: `status: 'pending_review'`, skip journal entry until confirmed

### One-step category entry (expense forms)
An entry form saves the expense ONCE, on its real category — never "save, then categorize".
- `GET /api/v1/agentbook-expense/categories/suggest?vendor=&description=&amountCents=` → `{categoryId, categoryName, confidence, source}` or `data: null`.
  Order: vendor default → learned `AbPattern` → one AI call (≥ 0.55, only if memory has nothing). Never the 6999 suspense account, never another tenant's account (`lib/agentbook-suggest-category.ts`).
- `POST /expenses` accepts `categoryId` (validated: this tenant's live expense account, else 400 `invalid_category`) and, ONLY when a human chose/accepted it, `categorySource: 'user' | 'user_corrected'` → `rememberVendorCategory` teaches the vendor memory. Agents/imports that name a category must NOT send `categorySource` (a guess must not become the vendor default).
- Desktop: `plugins/agentbook-expense/frontend/src/pages/NewExpense.tsx` (category select, prefilled, required for business expenses). Mobile: `app/app/capture/page.tsx` (suggestion chip with the AI pill; a category the person picked is never replaced). Client fetch: `suggestCategoryFor` in `app/app/_lib/api-extra.ts` (any failure → `null`).
- Remember to rebuild + COMMIT the plugin UMD bundle after changing `NewExpense.tsx` (see "Building Plugin Frontends" in CLAUDE.md).

### Ledger writer
Every journal posting goes through `apps/web-next/src/lib/ledger-writer.ts`: `appendBalancedEntry(client, tenantId, header, lines)` refuses unbalanced entries (`LedgerUnbalancedError`), and on a `(tenantId, sourceType, sourceId)` collision returns the existing entry when the payload (date + account/debit/credit lines) matches, else throws `LedgerKeyConflict` (carries `code: 'P2002'`; inside an aborted Postgres transaction it always throws). `assertPeriodOpen(client, tenantId, date)` is the closed-period gate, month derived in **UTC** (`LedgerPeriodClosedError`, re-exported as `ExpenseLedgerPeriodClosedError`). Expense edits of a tax-typed row (`taxCode` set) re-post as `DR category (amount − recoverableTaxCents) | DR 2100 (recoverable) | CR original credit (gross)`; untyped rows keep the legacy path. Pass the transaction client when you have one.

### Purchase tax codes (PR 2b)
- Engine: `packages/agentbook-jurisdictions/src/tax-codes.ts` — `computeLineTax({ jurisdiction, region, taxCode, amountCents, inclusive, registration, isMeal })`, `listTaxCodes`, `defaultTaxCode`. AU `GST/CAP/FRE/INP/NTR`, CA `GST/HST/GST_PST/GST_QST/ZERO/EXEMPT/OUT_OF_SCOPE` (rates from `ca/sales-tax.ts`, never literals), US `SALES_TAX/NONE` (never recoverable). Golden tests in `src/__tests__/tax-codes.test.ts`.
- App adapter: `apps/web-next/src/lib/tax-codes.ts` maps an `AbTenantConfig` row (jurisdiction, region, `gstRegistered`, `qstRegistered`) onto the engine; UK/unknown → `null` (gross). Posting resolution: `lib/expense-tax.ts` `resolveExpenseTax` (printed OCR tax wins within 2¢, else flagged); entry-UI view: `lib/expense-tax-row.ts` served by `GET /api/v1/agentbook-expense/tax-codes?amountCents=&inclusive=&taxCode=`.
- Posting: a registrant's typed expense is `DR category (gross − recoverable) | DR 2100 (recoverable) | CR 1000 (gross)`; non-registrants / US / `gstRegistered === null` post gross (null also shows the Business Profile prompt). `amountCents` is always the document gross; `taxInclusive` is input mode only. Amend recomputes `recoverableTaxCents` from amount + code.
- Registration flags live only in Business Profile (`AgentBookSettingsPanel`), PUT `agentbook-core/tenant-config` validates them tri-state.
- Readers: never read `amountCents` as a deduction — use `deductibleCents(expense)` from `lib/expense-amounts.ts` (guarded by `deductible-readers.test.ts`). Returns: BAS 1B/G10/G11 and CA ITC/QST ITR sum `recoverableTaxCents` for typed rows, `taxAmountCents` for untyped.
- Prod e2e: `tests/e2e/mobile-app/tax-codes.spec.ts` (sydney/maya/alex; sets `gstRegistered` for the run only if not already true and restores it).

### Bills / purchases (PR 3bc)
- Engine: `apps/web-next/src/lib/purchases.ts` — `postBill`, `payBill` (full or partial), `voidPayment`, `voidBill`, `amendBill`, all on the ledger writer (balanced, period-gated, keyed `(tenantId, sourceType, sourceId)`; sourceTypes `bill`, `bill_payment`, `bill_payment_void`, `bill_void`, `bill_amend`, `bill_amend_reversal`). Throws `PurchaseError(status, code)`; routes echo `{ success: false, code }`.
- Routes (`agentbook-expense/bills`): `POST` create; `GET/PUT/PATCH/DELETE /:id` (read, legacy edit, amend at_entry, void); `POST /:id?action=pay` (body `amountCents` for partial; response carries `payment`); `DELETE /:id/payments/:paymentId` void payment. Soft-deleted bills (`deletedAt`) are 404 everywhere. Wiring tests: `bills/__tests__/route-wiring.test.ts` (fake ledger, `lib/__tests__/fake-ledger-db.ts`).
- Posting modes: `at_entry` = DR category net | DR 2100 recoverable | CR 2000 on billDate, pay DR 2000 / CR 1000; `at_payment` (legacy, cash-basis tenants) = nothing until paid, then DR category / CR 1000. Every pay/void dispatches on the bill's own `postingMode`.
- Flag `purchases_at_entry` (`lib/purchases-flag.ts`, fail-closed): FeatureFlag `enabled` = global, else `metadata.tenantIds` allowlist; applies only to accrual tenants (`purchasesAtEntryApplies`). Enable: `npx tsx agentbook/enable-purchases-at-entry.ts` (dry run; `--apply`, `--email x`, `--remove`, `--global on|off`).
- Readers: unpaid = `open|partial`, amounts outstanding (`lib/bill-amounts.ts`); balance sheet reads journal 2000 for at_entry and derived AP for at_payment (`lib/balance-sheet.ts`); BAS/CA bills in `lib/tax-return-bills.ts`; Docs/Expenses `GET agentbook-expense/purchases` (`lib/purchases-view.ts`); `?basis=cash` guard `lib/cash-basis-guard.ts`.
- Prod e2e: `tests/e2e/mobile-app/bills.spec.ts` (default phase flag-on; `BILLS_E2E_PHASE=flag-off` for the legacy check).
- Surfaces (PR 3d): web Bills page `plugins/agentbook-expense/frontend/src/pages/Bills.tsx` (Open = open|partial / Overdue / Paid, aging from `reports/ap-aging`, add, edit = PATCH amend for at_entry / PUT for at_payment, pay, pay part, void, payment void; rebuild + commit the UMD bundle). Mobile Capture "Pay later" (manual business entry) → `createBill` in `app/app/_lib/api.ts` (key in `Idempotency-Key` + body); offline → `queueBill` (`lib/offline-queue.ts`, replayed to `/bills` with the same key by the page and `public/sw.js`). `POST /bills` takes `categoryId` (tenant-scoped) and replays an `idempotencyKey` for at_payment bills too. Home `bill_due` alert covers every open|partial bill in the window (`bill_due:many` + `count`).
- Chat (PR 3d): `record-bill`, `pay-bill`, `query-payables` (patterns in `plugins/agentbook-core/backend/src/bill-chat.ts`, mirrored in `consultation-triage.ts` DATA_QUESTION; record-expense / record-invoice-payment / aging-report exclude them). Handlers in `server.ts` call the bills routes only; `manage-bills` keeps its manifest with no triggers and delegates. `pay-bill` with no matching open bill + an amount falls back to `record-expense`. Routing test: `__tests__/bill-chat-routing.test.ts` (code, DB and prod-unseeded skill order; web/telegram/mcp).
- Bank match (PR 3d): `matchTransactionWithCandidates` (`lib/agentbook-payment-matcher.ts`) proposes unpaid bills for a debit (`scoreBillMatch`); `applyBillMatch` (`lib/agentbook-bank-match.ts`) pays the bill via `payBill` (key `bank:<txnId>`) and sets `matchedBillId` — never an expense. Wired: bank-sync auto-match (`runMatcherOnTransaction`), `POST bank-transactions/:id/match {targetType:'bill'}`, candidates route, Telegram `bnk_match` / expense picker; daily-pulse skips debits with a bill candidate. Prod e2e: `tests/e2e/mobile-app/bills-ui.spec.ts`.

### Inventory: items, purchases, on-hand (PR 5A)
- Engine: `apps/web-next/src/lib/inventory.ts`. Weighted average; value is integer cents (`onHandValueCents`), qty math in integer ten-thousandths (`toUnits` converts a Float bill/invoice qty via its 4-dp string). Relief = `round(value × out ÷ qty)`, the last unit takes the remainder; negative stock relieves 0 and the purchase that brings qty back to ≥ 0 posts a `stock_adjust` true-up (`trueup:<source>`) vs COGS.
- Roles: `resolveAccountByRole(db, tenant, 'inventory'|'cogs'|'shrinkage'|'opening_equity')` → 1500 / 5990 (US/CA; 5000 on AU/UK packs) / 5995 / 3900. Tenants whose jurisdiction has no wired chart (uk today) get the US chart, so cogs = 5990. **Owner-call O3 deviation:** UK tenants run on the US chart where 5000 is Advertising; a UK pack must move COGS to 5000.
- Purchases: a bill line with `itemId` (+ `qty`) debits 1500 instead of an expense. **Rule:** `at_entry` bills move stock at bill entry (net of recoverable tax); `at_payment` bills move it at payment. Both value stock NET of recoverable tax; the recoverable part is debited to 2100 (controller ruling). `voidBill` / `voidPayment` reverse the movement exactly (`bill_line_void`). Amending a bill with inventory lines is refused (409 `bill_has_inventory_lines`) — void and re-enter.
- Routes (`/api/v1/agentbook-expense/inventory/…`): `items` GET (stock on hand + summary) / POST (409 `duplicate_sku`), `items/:id` GET (+ movements) / PATCH / DELETE (soft only), `items/:id/opening` (DR 1500 | CR 3900, one per item), `items/:id/adjust` (shrinkage 5995; Idempotency-Key replays), `movements`, `low-stock`. All need `trackInventory` for writes; cross-tenant ids are 404 (no FK on itemId).
- Gate: `AbTenantConfig.trackInventory` (Business Profile toggle, offered only to the `merchant`/`retail` business types, or shown when already on). Never gate on businessType. COGS/shrinkage/inventory accounts are hidden from expense pickers (`accounts?type=expense`) and auto-categorise (`withoutInventoryRoles`).
- Surfaces: web Expenses › Items tab (plugin `agentbook-expense`, rebuild + commit the UMD bundle), chat skill `query-stock`, mobile Home `low_stock` alert → `/app/chat?topic=low_stock`. AU P8 closing stock reads the 1500 balance at year end; cost of sales is net 5000 + 5995.
- Tests: `lib/__tests__/inventory.test.ts` (fake ledger: WAC golden, zero at zero, true-up, period gate, replay), `__tests__/api/v1/agentbook-expense/inventory-routes.test.ts`. Sales/COGS posting is PR 5B (`relieveStock` is the hook).

### Inventory: sales, COGS, reports (PR 5B)
- Posting point: COGS posts **when the invoice posts revenue — at creation** (draft included), inside the invoice transaction: `postInvoiceCogs` → `relieveStock` per line with `itemId`, `DR cogs | CR 1500`, `sourceType 'stock_sale'`, `sourceId` = the invoice line id (idempotent). Only when `trackInventory` is on; lines without `itemId` never touch stock. `itemId` on `AbInvoiceLine` has no FK — `POST /agentbook-invoice/invoices` checks tenant ownership (`assertItemsOwned`, foreign id → 404, nothing written).
- Void: `POST invoices/:id/void` → `voidInvoiceCogs`: per item line, the line's NET sold qty/value (sale + edit reposts − edit reversals) goes back at exactly the value it left with, `stock_sale_void` / line id (`DR 1500 | CR cogs`).
- Edit: `PATCH invoices/:id { lines: [{ id, quantity }] }` — **draft only**, no payments, no deferral. Revenue: mirror-reverse the current entry (`invoice_edit_reverse` / `<invoiceId>:<rev>`) and post the recomputed one (`invoice_edit` / same key; `invoice.journalEntryId` moves to it, so a later void mirrors the right entry). COGS: `repostInvoiceLineCogs` → `stock_sale_edit_reverse` + `stock_sale` keyed `<lineId>:<rev>`.
- Negative stock: selling more than on hand is allowed (the movement's `negative` flag); relief stops at the value on hand, and the next purchase/opening that brings qty ≥ 0 posts the `stock_adjust` true-up vs COGS (5A).
- Accounts: COGS = `resolveAccountByRole('cogs')` → 5990 US/CA (UK on the US chart), 5000 AU — it is an expense account, so it lands on the P&L under that code. Shrinkage write-off = `items/:id/adjust` with negative qty and a reason → 5995 (Items page "Write off" dialog requires the reason).
- Report: `GET /agentbook-expense/inventory/cogs?from&to&granularity=month|quarter` (`cogsByPeriod`: net of voids/edit reversals; true-ups are excluded from the report and stay on the P&L). Items page shows COGS by quarter. Chat: `query-cogs` (this quarter by default; this month / this year / last quarter) — routed through consultation-triage (`DATA_QUESTION` pattern) and `QUERY_COGS_PATTERN`.
- UI: New Invoice line item picker (`invoice_ui.inventory_item`) appears only when `trackInventory` is on; picking fills description and sale price and sends `itemId`.
- Tests: `lib/__tests__/inventory-sales.test.ts` (fake ledger), `__tests__/api/v1/agentbook-invoice/invoice-cogs-routes.test.ts` (real create/void/PATCH/cogs handlers; mutation-checked), `query-cogs-skill.test.ts`, `new-skill-chat-routing.test.ts`, `new-invoice-item-picker.test.tsx`, `items-page.test.tsx`; prod: `tests/e2e/mobile-app/inventory-sales.spec.ts` (bill-in → sell → void → unwind; every touched account back to baseline).

### Bank Reconciliation
1. Plaid Link → `POST /plaid/create-link-token` → `POST /plaid/exchange-token`
2. `POST /bank-sync` → fetch transactions from Plaid API (last 30 days)
3. Auto-match: each bank txn checked against expenses (amount ±5%, date ±2 days)
4. Matched → `matchStatus: 'matched'`, linked via `matchedExpenseId`
5. Unmatched → `matchStatus: 'pending'` → proactive alert after 7 days

## Testing

### E2E Tests (Playwright)
```bash
cd tests/e2e && npx playwright test --config=playwright.config.ts
```

Key test files:
- `phase11-competitive-gaps.spec.ts` — 33 tests (invoicing, PDF, email, recurring, credit notes)
- `phase12-ai-native-moat.spec.ts` — 33 tests (conversational memory, workflows, digital twin, personality)
- `expense-advisor.spec.ts` — 10 tests (insights, charts, Q&A)
- `expense-gaps.spec.ts` — 14 tests (review queue, blob storage, OCR, CC import, proactive alerts)
- `ca-consultant-tax-2026.spec.ts` — 40 tests (Canadian tax scenario)

### Testing a Specific Feature
```bash
npx playwright test <filename>.spec.ts --config=playwright.config.ts
```

### After Backend Changes
Kill and restart the affected backend, then run tests:
```bash
lsof -i :<port> -t | xargs kill 2>/dev/null
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=<port> npx tsx plugins/<name>/backend/src/server.ts &
```

### Editing employee profiles / sensitive fields (PR 4b)
- PUT `agentbook-payroll/employees/[id]` rejects unknown keys (400). Bank `bankAccount` is the account number only; the routing part goes in `bankRoutingLabel` (BSB / transit+institution / ABA / sort code), validated per market. Masked echoes (`***-**-1234`) are ignored, never stored.
- Changing `jurisdiction` while a tax id is stored needs a new `taxId` in the same request (400 `tax_id_reentry_required`).
- Set `EMPLOYEE_PII_ENCRYPTION_KEY` on Vercel prod and preview before using sensitive fields; without it they return 503 `pii_key_unconfigured`.
- Reveal: `POST employees/[id]/reveal {field: taxId|bankAccount|superMemberNumber}`, owner session only, audited. Never log request bodies or values.
- Tests: `employee-privacy-routes.test.ts`, prod e2e `tests/e2e/mobile-app/employee-privacy.spec.ts`.

### Payroll dates: pay date for statutory reports, period end for the journal (PR 4d, owner call O1)
- Statutory reports bucket a pay run by `payDate ?? periodEnd`: STP (`au/stp`: FY + YTD window), BAS W1/W2 (`agentbook-tax/au/bas-return`), year-end W-2/T4/payment summaries and their PDF (`year-end`, `year-end/pdf`), the 941/940 tax-deposit PDF, and the deposit period accrued when a run is processed (941/BAS/SG/940/T4 remittance quarter or year). Legacy runs with `payDate = null` keep their old periodEnd bucket.
- The payroll journal entry stays dated `periodEnd` (expense recognised when earned; `pay-runs/[id]/process`). Never use the pay date there.
- Use `lib/payroll-pay-date.ts`: `statutoryPayDate(run)` for a date, `payRunStatutoryDateWhere({gte, lt|lte})` for a Prisma `AbPayRun` filter (spread it; inside `payRun: {...}` for stub queries). A new statutory consumer must use these, never `periodEnd` directly.
- Internal-only `periodEnd` readers stay: pay-run list ordering, STP target selection (latest by period end), chat "last run" summary, the dashboard list.
- Footers: `core_ui.payroll_reports_use_pay_date` (payroll Tax deposits / Year-end / STP tabs) and `tax_ui.return_wages_by_pay_date` (BAS when W1/W2 show).
- Tests: `paydate-statutory-buckets.test.ts` (quarter + year boundary fixture, where-applying DB mock, processed-run snapshot), prod e2e `tests/e2e/mobile-app/paydate.spec.ts` (read-only: pay runs can't be deleted and processing merges into shared deposit rows).

### Employee profile UI, pay frequency, draft pay runs (PR 4c)
- Profile screen: `apps/web-next/src/app/(dashboard)/payroll/employees/[id]/employee-detail.tsx` (route `/payroll/employees/<id>`, linked from the payroll list). Sections by market; sensitive inputs start empty (masked last4 is the placeholder) and blank/masked echoes are never sent; a 503 `pii_key_unconfigured` disables them and re-sends the rest.
- Frequency labels: `frequencyLabelKey(freq, jurisdiction, ns)` in `lib/payroll-frequency.ts` — AU biweekly → `fortnightly`, else `bi_weekly`; keys live in `core_ui` (web) and `agent` (chat replies via `replyT`). Stored values never change.
- Drafts: `POST pay-runs {generate:'drafts', asOf?, employeeIds?}` → one draft per frequency group (weekly/biweekly also by anchor) from `payAnchorDate` (fallback `startDate`), with `payDate` (= period end) and `payFrequency`; idempotent per group+period. Period math is `payPeriodFor()` (UTC, date-only). Stubs use the current rate, so rate edits hit the next draft only. `DELETE pay-runs/[id]` removes drafts only (409 otherwise).
- Tests: `payroll-frequency.test.ts`, `pay-runs-drafts-route.test.ts`, `payroll-employee-detail.test.tsx`, `payroll-page-frequency-drafts.test.tsx`; prod e2e `tests/e2e/mobile-app/employee-ui.spec.ts`.

### Employee / pay-frequency chat (PR 4e, R-EMP-5)
- Skills (`built-in-skills.ts`, INTERNAL handlers in `server.ts` → `executeClassification`): `query-employee` ("what's Jane's pay frequency / rate / next pay date", "list my employees"), `update-employee` (pay frequency or pay rate only, `confirmBefore: true` → plan card; executes `PUT employees/[id]` so it gets the same zod schema + `AbEmployeeChange` audit; reply says it applies from the next draft run), `generate-pay-run-drafts` (`POST pay-runs {generate:'drafts'}`). Routing patterns `EMPLOYEE_EDIT_PATTERN` / `PAY_RUN_DRAFTS_PATTERN`; `payroll-status`, `run-payroll`, `record-expense`, `set-vendor-alias` exclude them.
- Pure helpers in `employee-chat.ts`: name matching, frequency/rate parsing, `agentFrequencyLabelKey` (mirror of `frequencyLabelKey(…,'agent')`, pinned by `apps/web-next/src/__tests__/lib/employee-chat-label-parity.test.ts`), `containsSensitiveTaxId` / `redactSensitive`.
- Privacy: chat never reads `AbEmployeeSensitive` (reads `select` plain columns). A tax-id/bank/super ask is refused with "use the profile screen"; a message CONTAINING an SSN/SIN/TFN-shaped value is refused at the top of `handleAgentMessage` before classification/LLM/session/memory, and the single `AbConversation` row stores the redacted text.
- MCP parity: MCP's `ask_agentbook` tool calls the same agent brain, so these skills (and the refusal) reach MCP with no MCP-specific code.
- Reply keys: `agent.employee_*`, `agent.pay_run_*` in en/fr-CA/zh-CN. Tests: `employee-chat-skills.test.ts`, `employee-chat-brain.test.ts`; prod e2e `tests/e2e/mobile-app/employee-chat.spec.ts`.
