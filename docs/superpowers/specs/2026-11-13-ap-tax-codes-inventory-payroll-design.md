# Bills (AP), tax codes, one-step categorisation, inventory and payroll completeness — design

Date: 2026-11-13 · Status: rev 3 (after two architecture reviews) · Markets: US, CA, AU
Verified against `origin/main` dbbaedf6. Rev 1 wrongly stated that no bill model exists; see §1.

## 1. Why — what the tester saw vs. what the code does

| # | Tester report | Reality in code |
|---|---|---|
| 1 | Unpaid bill is not in the accounts | **A bills feature exists** and is live: `AbBill` (`vendorName`, one `amountCents`, `categoryCode`, `dueDate`, `status open\|paid\|cancelled`, `journalEntryId`), routes `agentbook-expense/bills` + `bills/[id]`, AP-aging report, balance-sheet derivation (`reports/balance-sheet/route.ts:76-98`), mobile Home "bill due" alert (`lib/mobile/home.ts`), Upcoming (`lib/mobile/upcoming.ts`), CPA-run input (`lib/cpa-run.ts`), tenant-deletion registry, chat skill `manage-bills` (INTERNAL handler in `plugins/agentbook-core/backend/src/server.ts`). It posts **only at payment**: `DR expense / CR 1000`, `sourceType 'bill'`, `sourceId null`, no idempotency, no closed-period gate, and falls back to the "first active expense account" when `categoryCode` is empty. Nothing posts while the bill is unpaid, so AP never appears in the ledger — exactly what the tester saw. |
| 5 | Paid bill not in Expenses | The payment does hit the journal (P&L is right) but creates no `AbExpense` row, so the Expense/Docs list (table-based) never shows it. |
| 2 | No GST entry | Receipt OCR already extracts `tax_cents` and persists `AbExpense.taxAmountCents` (`lib/agentbook-receipt-ocr.ts`, `lib/mobile/from-receipt.ts`); BAS 1B and the CA GST/HST return already sum it. What is missing: manual / chat / web-form entry of tax, tax **codes** (GST-free, input-taxed, capital), inclusive/exclusive, and any recoverable-vs-cost split. |
| 3 | No inventory | No inventory model, account, or flow. AU/UK charts have `5000 COGS`; no inventory asset account. |
| 4 | Category is a second step | Mobile capture has an AI guess but saves via a `categorize` + `confirm` call pair (`app/capture/page.tsx`); web forms leave category empty → `6999` suspense until set. |
| 6 | No employee edit | `PUT employees/[id]` exists with an allow-list that silently drops unknown keys; the payroll page has an add form only. No TFN/SIN/bank/super/residency fields exist. |
| 7 | No pay frequency | `AbEmployee.payFrequency` supports weekly/biweekly/semimonthly/monthly but only at add time and as raw strings ("biweekly" shown to AU users). `AbPayRun` has no pay date or frequency: STP and BAS W1/W2 key off `periodEnd`. |

Five themes: **evolve the existing bills into a real payables document**, **tax codes as data**, **one-step entry**, **inventory**, **employee records**.

## 2. Goals / non-goals / anti-goals

Goals
- G1. A bill entered unpaid is on the books on its bill date (AP credited); paying it moves AP to cash and creates no second expense. Existing bills keep working unchanged.
- G2. Every purchase line carries a tax code; AU BAS (G10, G11, 1B), CA GST/HST return (ITC) and US sales-tax-as-cost come from line data.
- G3. Expense/bill entry is one confirm with category and tax prefilled.
- G4. Small-business inventory: purchase → on-hand → sale relieves stock at cost → COGS.
- G5. Employee profile viewable/editable incl. market-specific tax, bank and super data; pay frequency visible and driving pay-run dates and STP.

Non-goals (v1)
- Multi-currency bills: a bill in a currency other than the tenant's is rejected with 422 `bill_currency_unsupported` (invoices have `originalCurrency`; bills do not get FX gain/loss until a later design).
- Vendor credits/refunds, prepayments/deposits, recurring bills, landed cost, multi-warehouse, lot/serial, manufacturing, CA Quick Method, selectable bank account on payment (payments credit `1000`, as expenses do; credit `1200`-type accounts would be invisible to the cash-basis estimate).
- Direct ATO lodgement (STP route aggregates; transport stays provider-side).
- UK: not a launch market. Note the UK chart is not wired into `CHART_PROVIDERS` (UK tenants fall through to the US chart today); this design neither fixes nor depends on that.

Anti-goals
- A second expense row when a bill is paid.
- Any posting path without balanced entry, closed-period check and idempotency key.
- TFN, SIN, bank number or super member number in logs, chat, search context, error reports, exports.
- Silently reinterpreting legacy rows (single `taxAmountCents`, payment-time bills).
- Double-counting AP (journal `2000` plus a derived "open bills" figure).
- A cash-basis tenant, or an accrual tenant viewing `?basis=cash`, silently losing a bill's cost.
- Non-GST-registered tenants being shown or credited input tax.

## 3. Constraints

- **Journal**: `@@unique([tenantId, sourceType, sourceId])`; entries are immutable; corrections are reversing entries keyed by the superseded entry (the `expense_amend_reversal` pattern in `agentbook-expense-ledger.ts`). All new postings go through one writer with a closed-period check (`AbFiscalPeriod`). Today `appendBalancedEntry` and `assertPeriodOpen` are **module-private** in `agentbook-expense-ledger.ts` and `appendBalancedEntry` re-throws a raw unique-key error (P2002); PR 2a exports them behind a `lib/ledger-writer` that catches P2002 and returns the existing entry (idempotent replay), and derives the period in UTC (the current local-time derivation can put a UTC-midnight bill in the previous month). The legacy bill-pay route has neither the gate nor idempotency; this design fixes that on the way.
- **Next route handlers in production**; libraries in `apps/web-next/src/lib`; plugin frontends cannot import them.
- **Charts**: every jurisdiction chart has both `1000 Cash` and `1200 Business Checking/Transaction`; `CASH_CODE='1000'` and the estimate, P&L, bank-match and bill-pay all use `1000`. `2000 AP` and `2100 GST/HST Payable` exist in US/CA/AU/UK. `1400` is **Term Deposits (AU)** — do not reuse. `1500` is free in all four. New accounts are added through `ensureChartOfAccounts` (back-fills missing pack accounts): `1500 Inventory`, `3900 Opening Balance Equity` (both verified free in all four charts). **COGS is not `5000` everywhere**: `5000` is *Advertising* in the US and CA charts and *Cost of Goods Sold* in AU/UK, and 5000–5900 are all occupied. Inventory code therefore resolves accounts **by role**, not literal code: `cogs` → `5000` on AU/UK, new `5990 Cost of Goods Sold` on US/CA; `shrinkage` → new `5995 Inventory Shrinkage` everywhere (plan task 1 of PR 5 confirms 5990/5995 are free and sets their `taxCategory`: Sched. C line 4 / T2125 Part 3).
- **Accounting basis** `AbTenantConfig.accountingBasis` (accrual default | cash); the estimate and P&L also accept a `?basis=` override. Cash-basis counts expense-account movement in entries that also move account `1000`.
- **Registration flags**: `AbTenantConfig.gstRegistered Boolean?` (tri-state) already exists. Add `qstRegistered Boolean?` (CA) and `gstReportingBasis 'accrual'|'cash'` (AU; default accrual).
- **Schema deploys**: remote builds run `prisma db push`; all changes additive (nullable/defaulted columns, new tables, no renames, no enum-semantic changes). Each schema change ships in its own small PR and merges promptly.
- i18n (en, fr-CA, zh-CN), mobile hygiene guard, chat parity guard, tenant export (`me/export`) and tenant deletion registry (`agentbook-tenant-data-models.ts`).

## 4. Architecture

```
 Capture / chat / Bills page / bank match           Payroll page
        │                                                │
        ▼                                                ▼
  lib/purchases  ── postBill / payBill / voidBill / amendBill ──┐   lib/employees
        │ uses                                                   │      │
        ├── lib/tax-codes (pure, per jurisdiction, shared w/ chat) │      ├─ AbEmployeeSensitive (encrypted)
        ├── lib/inventory (WAC, stock movements)                   │      └─ AbEmployeeChange (audit)
        └── appendBalancedEntry + assertPeriodOpen  ◄──────────────┘
                      │
             journal ─► P&L, balance sheet, AP aging, BAS, GST/HST return, tax estimate
```

Principle: reports read the **journal**; tables only attribute. A purchase paid on the spot stays on the existing `AbExpense` path, unchanged. The `manage-bills` INTERNAL chat handler and the bills routes become thin callers of `lib/purchases`; nothing writes `abBill` directly.

## 5. Design

### 5.1 Tax codes

**Table** in `packages/agentbook-jurisdictions` (pure data + pure functions; routes, chat, OCR post-processing and returns all call it — one source, rates from the existing `sales-tax.ts` providers, never duplicated):

| Jurisdiction | Codes | Recovery |
|---|---|---|
| AU | `GST` (taxable purchase), `CAP` (capital purchase → BAS **G10**), `FRE` (GST-free), `INP` (input-taxed), `NTR` (no GST / outside scope) | `GST`,`CAP` recoverable iff `gstRegistered === true` |
| CA | `GST`, `HST`, `GST_PST`, `GST_QST`, `ZERO`, `EXEMPT`, `OUT_OF_SCOPE`; province + date resolve the rates via `caSalesTax.getRates` (no per-province codes) | GST/HST recoverable if registered; QST only if `qstRegistered`; PST never; each category has a `recoverableFraction` (meals & entertainment 0.5) |
| US | `SALES_TAX`, `NONE` | never recoverable; added to cost |

`computeLineTax({ code, grossCents, region, date, jurisdiction })` → `{ netCents, taxCents, recoverableCents, nonRecoverableCents }`. Rules: `amountCents` is **always the document gross total** and `taxAmountCents ⊂ amountCents`; `taxInclusive` is a UI flag only (input mode), not stored semantics. AU inclusive back-out is `round(gross/11)`; exclusive is `round(net×0.10)`; CA uses the combined province rate, rounded per component as `ca/sales-tax.ts` does. Rounding is half-away-from-zero (credits/refunds symmetric).

**Schema (additive)** on `AbExpense` (and `AbBillLine`): `taxCode String?`, `recoverableTaxCents Int @default(0)`. `taxAmountCents` is unchanged = total tax on the document. Rows with `taxCode = null` are "untyped legacy".

**Posting decision (resolves the gross/net question).** For a tenant where tax is recoverable (AU `gstRegistered===true`; CA registrant), a typed purchase posts `DR category (net + non-recoverable tax) | DR 2100 (recoverable tax) | CR cash/AP (gross)`. 2100 is the GST control account, so the BAS/GST-HST net is visible in the ledger. For non-registered tenants and US, the full gross goes to the category (no split, no tax row shown). This makes P&L, deductions and the estimate net of recoverable tax for registrants, which is correct (recoverable GST is not a deductible expense).
**Ledger-lib prerequisite (PR 2a, before any 3-line entry is written).** The expense edit/delete code assumes 2-line (or 3-line-with-tax-liability) shapes: `repostExpenseJournalEntry` throws `ExpenseLedgerShapeError` on any amount or category change of a non-"simple" entry, and `reclassifyFromSuspense` only handles exactly one debit line on `6999`. Writing `DR category | DR 2100 | CR cash` first would make every registrant's typed expense uneditable and leave uncategorised typed expenses stuck in suspense. PR 2a therefore (a) adds a tax-aware repost that recomputes the category/2100 split from `amountCents`, `taxCode`, `recoverableTaxCents`, (b) makes the suspense reclassification tolerate a 2100 line, (c) extends the amend/delete reversal tests to 3-line and split-with-tax shapes, all behind unchanged behaviour for untyped rows.

**One deductible figure.** Journal readers (P&L, estimate) become net for registrants, but table readers (`agentbook-deduction-rules.ts`, category breakdown, vendor reports, `AbExpense.taxCategory` snapshot consumers) read gross `amountCents`. PR 2b introduces a single accessor `deductibleCents(expense) = amountCents − recoverableTaxCents` and migrates every table reader (the plan's first task enumerates them with grep and a guard test that fails on direct `amountCents` use in those modules).

**Restatement of legacy rows** (opt-in, per tax year, preview first) is done as **amend-reversal + 3-line repost of the original entry** using PR 2a's tax-aware repost and the existing `expense_amend*` keys — not a free-standing `DR 2100 / CR category` entry, which would be orphaned by a later delete/amend and invisible to the cash-basis view. Date rule: the original's date; a row in a closed period is **not restated** (listed as skipped). Until accepted, reports show a note ("N purchases before <date> include GST in expense").

**Returns**: BAS 1B / G10 / G11 and the CA ITC sum `recoverableTaxCents` for typed rows and fall back to `taxAmountCents` for untyped rows exactly as today (golden mixed fixture). AU: if `gstReportingBasis === 'cash'`, bill-based amounts count by payment date pro-rata; otherwise by bill/expense date. `gstRegistered === false` ⇒ no recoverable split and 1B = 0 and the UI hides the tax row; `null` (unknown) shows a one-line prompt to set registration and posts gross until answered. This registration gate is **new** — the BAS route has none today.

**Entry UI**: tax row (code chip + amount) in capture review, web expense form and bill form; code defaulted from vendor (`AbVendor.defaultCategoryId`/`AbPattern` store, extended with `defaultTaxCode`); OCR keeps `tax_cents` and adds `taxLabel`; printed amount wins if it differs from the computed one by ≤ 2¢, else the row is flagged for review. Chat: "$110 incl GST" parsed by the same function.

### 5.2 Bills & accounts payable — evolve the existing `AbBill`

**5.2.0 Additive evolution.** Keep every existing column and row. Add nullable/defaulted columns to `AbBill`: `vendorId`, `billNumber`, `billDate`, `subtotalCents`, `taxCents`, `recoverableTaxCents`, `paidCents Int @default(0)`, `currency`, `postingMode String @default("at_payment")` (`at_payment` | `at_entry`), `revision Int @default(0)`, `idempotencyKey`, `receiptUrl`, `deletedAt`. Status values: existing `open|paid|cancelled` plus `partial` and `draft`; every existing reader is updated to treat `open` and `partial` as unpaid (Home, Upcoming, CPA run, aging, `manage-bills`).
New tables `AbBillLine` (`billId, tenantId, description, categoryId?, itemId?, qty, unitCostCents, amountCents, taxCode, taxCents, recoverableTaxCents`) and `AbBillPayment` (`billId, tenantId, date, amountCents, method, journalEntryId, idempotencyKey`).

**Posting mode.**
- **Legacy rows and cash-basis tenants** = `at_payment`: behaviour unchanged (`DR expense / CR 1000` at payment) — cash tenants keep working Bills. The route now uses `appendBalancedEntry` + `assertPeriodOpen`, a real `sourceId` (the payment id for new payments; legacy `sourceId null` entries are left alone), and no silent fallback account: a missing category yields `6999` suspense like expenses.
- **New bills for accrual tenants** = `at_entry` (default). Existing open `at_payment` bills keep their mode; the UI offers "post to books now" which posts the entry-date entry and flips the bill to `at_entry` only with a one-off adjusting reclass guarded by `bill_convert` (explicitly specified in the plan; v1 may omit conversion and just leave legacy open bills as they are).

**Entries for `at_entry`** (all inside one transaction with the document write):
| Event | Entry | sourceType / sourceId |
|---|---|---|
| Bill entered (open) | `DR expense per line (net + non-recoverable tax) [inventory lines → 1500] | DR 2100 recoverable tax | CR 2000 total` | `bill` / `bill.id` |
| Payment | `DR 2000 | CR 1000` | `bill_payment` / `payment.id` |
| Void unpaid | mirror of the bill entry, swapped | `bill_void` / `bill.id` |
| Void a payment | mirror of that payment entry | `bill_payment_void` / `payment.id` |
| Amend open bill | reversal of the current entry **keyed by the superseded entry id**, then new entry | `bill_amend_reversal` / `<entryId>`, `bill_amend` / `<bill.id>:<revision>` |
Legacy `at_payment` entries keep `sourceType 'bill'` with `sourceId null`; no code may assume `bill` ⇒ at-entry (distinguish by `AbBill.postingMode`). Every new sourceType handles P2002 as **replay-or-retry**: same payload ⇒ return the existing entry; the amend revision is bumped inside the same optimistic `updateMany` that guards `paidCents`, and a lost race retries rather than failing. Paid bills must have payments voided before the bill is voided; `partial` bills can be voided only after all payments are voided.

**Concurrency/idempotency**: payment creation uses an optimistic guard `updateMany({ where: { id, paidCents: prev }, data: { paidCents: next } })` with retry (Prisma has no `FOR UPDATE`; no raw lock needed); overpayment → 422. `idempotencyKey` on bill and payment create supports the offline queue like `from-receipt`.

**Reads that must change in the same PR as the first at-entry posting** (else AP double-counts and the sheet unbalances). Complete consumer list of `AbBill`/`status:'open'`: `bills/route.ts` GET (`overdue`, `openCents`), `bills/[id]/route.ts` (pay, DELETE), `reports/ap-aging`, `reports/balance-sheet` + `lib/balance-sheet.ts` (`sumOpenBills`), `lib/mobile/home.ts`, `lib/mobile/upcoming.ts`, `lib/cpa-run.ts`, the `manage-bills` and **`cpa-review`** INTERNAL skills in `plugins/agentbook-core/backend/src/server.ts`, the deletion registry, and the fixtures/tests (`mobile-fixtures.ts`, `calendar-upcoming-route.test.ts`, `mobile-home-route.test.ts`). Rules: unpaid = `open|partial`; balance-sheet AP for `at_payment` rows keeps the derived figure **and its retained-earnings offset**, for `at_entry` rows AP comes from journal `2000` with **no** offset (their expense is already in the journal), dated by `billDate` not `createdAt` (legacy rows without `billDate` fall back to `createdAt`, so legacy balance-sheet dates do not move). Guard test asserts `assets == liabilities + equity` for mixed sets and that no bill is counted twice.
**Legacy holes closed in 3b**: `DELETE bills/[id]` currently cancels a *paid* bill leaving its payment entry live (reject, or void the payment first); the pay route can mark a bill `paid` with `journalEntryId = null` when an account is missing (use `ensureChartOfAccounts`; fail the request instead). `?basis=cash` on an accrual tenant is disabled (banner) while open `at_entry` bills exist, because pro-rata recognition of the P&L/estimate is deferred (documented follow-up). **BAS is not deferred**: for `gstReportingBasis = 'cash'` the BAS route (1B, G10, G11) joins `AbBillPayment` and counts pro-rata by payment date; this is part of the same PR as the balance-sheet changes.

**"Paid bill missing from Expenses"**: the Docs/expense list reads a `PurchaseView` that unions `AbExpense` rows with bills (one row per bill, "Due 15 Nov / Paid" badge). Reports read the journal and are already right.

**Bank match**: the proposal heuristics (not `agentbook-bank-match.ts`, which only applies confirmed matches) get a bill candidate path; `AbBankTransaction` gains `matchedBillId`; `applyBillMatch` records a payment instead of an expense, preventing the likeliest double-count (bank import creating an expense for a paid bill).

**Surfaces**: web Bills page (Open/Overdue/Paid, aging buckets), mobile Capture "Pay later" toggle with due date, Home "N bills due" (already exists, extended), chat `record-bill`, `pay-bill`, `query-payables` (the `manage-bills` skill is reimplemented on `lib/purchases` and its manifest kept).

### 5.3 One-step categorisation

Make the existing flow one request: `POST expenses` (and the bill create) accept `{ categoryId, taxCode, confirm: true }`; capture review prefills category and tax and saves once instead of `categorize` + `confirm`. Suggestion order: `AbVendor.defaultCategoryId` / `AbPattern` hit above threshold → LLM constrained to the tenant's active expense accounts → none (then `6999` as today). Accepting raises confidence; changing records a correction through the existing path (the `AbPattern`/vendor store — **not** `AbUserMemory`, which is conversational memory). Only low-confidence rows enter the review queue. No schema change except `AbVendor.defaultTaxCode`.

### 5.4 Inventory

Opt-in tenant flag `trackInventory` (default off; offered to merchant/retail business types and via toggle — gate on the flag, not `businessType` alone).
- `AbInventoryItem`: `sku?, name, unit, onHandQty Decimal(14,4), onHandValueCents Int, reorderPoint?, salePriceCents?, isActive`. **Stock value is stored in integer cents** (`onHandValueCents`), average cost is *derived* (value ÷ qty), so the sub-ledger cannot drift from `1500` by rounding.
- `AbStockMovement`: `itemId, date, type purchase|sale|adjustment|opening, qty (signed), valueCents (signed), sourceType/sourceId, journalEntryId`.
- Method: weighted average, fixed in v1. A sale moves `valueCents = round(valueCents_on_hand × qtySold / qtyOnHand)` (the last unit takes the remainder), so on-hand value hits exactly 0 at qty 0.
- Purchase: a bill line with `itemId` debits `1500`, adds qty/value. Sale: the invoice line gains `AbInvoiceLine.itemId`; COGS posts **when the invoice posts revenue (creation)** — `DR 5000 COGS | CR 1500`, `sourceType 'stock_sale'`, `sourceId invoiceLine.id` (idempotent); invoice void posts `stock_sale_void`. Adjustments: `stock_adjust`; opening stock: `stock_opening` balanced to `3900`.
- Negative stock allowed with a warning; when a later purchase brings qty to ≥ 0 a `stock_adjust` true-up reconciles the value to `1500`.
- Reports: stock on hand, movement ledger, COGS by period, low-stock alert (Home/chat). Tax mapping targets: US Schedule C line 4/Part III, CA T2125 Part 3, AU: the PR confirms the exact tax-return rows for COGS/closing stock in the AU schedule code (rev 1's "P8" reference could not be verified in the repo and is dropped).
- Delivered in two phases (A: items + purchases + on-hand; B: sales/COGS/reports).

### 5.5 Employee profile & pay frequency

**Schema (additive)**:
- `AbEmployee`: `phone, address, dateOfBirth, endDate, employmentBasis (full_time|part_time|casual)`, AU `taxFreeThreshold, residency, helpDebt`, CA `td1Federal, td1Provincial, cppExempt, eiExempt`, US `extraWithholdingCents`.
- `AbEmployeeSensitive` (1:1, never returned raw): `taxIdEnc` (TFN/SIN/SSN), `taxIdLast4`, `bankAccountEnc`, `bankLast4`, `bankRoutingLabel`, `superFundUsi`, `superFundName`, `superMemberNumberEnc`. Encryption uses the existing AES-256-GCM helper in `lib/agentbook-bank-token.ts` pattern (separate key `EMPLOYEE_PII_ENCRYPTION_KEY`; **fails closed in production** — the existing helper falls back to an all-zero key outside prod, which must not apply here).
- `AbEmployeeChange` (audit: who, field, old→new; sensitive values never stored, only "changed").
- `AbPayRun`: add `payDate DateTime?`, `payFrequency String?`; `AbEmployee`: `payAnchorDate DateTime?` (per employee/frequency group; per-tenant anchors do not work for semimonthly).

**API**: new `GET employees/[id]` (masked); `PUT` becomes a zod-validated, per-jurisdiction schema (unknown keys rejected; callers audited before flipping to strict) and scopes the update by `tenantId` (hardening; the current handler's preceding `findFirst` is already tenant-scoped); `POST employees/[id]/reveal` (audited in `AbEmployeeChange`, rate-limited, owner/admin only). Edits to pay rate/frequency apply from the next draft run; processed runs are snapshots and stay untouched (covered by a test).

**Pay frequency**: stored values unchanged (`weekly|biweekly|semimonthly|monthly`); a display map gives "Fortnightly" (AU), "Bi-weekly" (US/CA) in all three catalogs and the chat reply catalog. Draft pay runs are generated per frequency group from the anchor (weekly 7d, fortnightly 14d, semimonthly 1st–15th/16th–end, monthly calendar). **Statutory reports switch from `periodEnd` to `payDate`**: STP, BAS W1/W2, year-end (W-2/T4/payment summary and PDFs) and payroll-tax deposits (`year-end/route.ts`, tax-deposits PDF, `au/stp`, `au/bas-return`); legacy runs with `payDate = null` fall back to `periodEnd`. **The payroll journal entry date deliberately stays `periodEnd`** (expense recognised when earned; `process/route.ts:87`) — so statutory reports follow payment date while the P&L follows the earned period; this is documented in the report footers and is a flagged owner decision (§9). A regression fixture crosses a BAS-quarter and a year boundary and asserts each consumer's bucket. Processed runs are already protected (re-process guard + stub snapshots); the change adds a test, not new machinery.

**Privacy plumbing (part of this PR, not follow-up)**: add `superFundUsi, superMemberNumber, taxIdEnc, bankAccountEnc, td1*, routingLabel` to `observability/scrub.ts` and its test; add the new tables to `me/export` (masked forms only) and to the tenant-deletion registry — and, since `me/export` today omits `AbBill`, `AbEmployee`, `AbPayRun`, `AbPayStub`, add those too (pre-existing privacy gap); chat/search never read `AbEmployeeSensitive`.

UI: employee detail screen (Personal, Pay, Tax, Banking, Super/Benefits by market) linked from the payroll list; mobile read-only view.

## 6. Per-market summary

| | US | CA | AU |
|---|---|---|---|
| Bills | at_entry for accrual; cash tenants keep at_payment | same | same |
| Tax | sales tax as cost; hidden unless present | GST/HST/PST/QST; ITC for registrants (QST separate flag; meals 50%) | GST/CAP/FRE/INP/NTR; BAS G10/G11/1B; cash or accrual GST basis |
| Inventory COGS | Sched. C | T2125 | confirmed in PR |
| Employee | W-4 | TD1, SIN | TFN, residency, super fund |
| Frequency label | Bi-weekly | Bi-weekly | Fortnightly |

## 7. Delivery order (each PR merged, deployed and prod-verified before the next)

1. **One-step categorisation** (no dependencies; cheapest visible fix).
2. **Tax codes**: **2a** ledger-writer extraction (export + P2002 replay + UTC period), tax-aware repost, suspense reclass tolerant of 2100, shape tests — no behaviour change for untyped rows; **2b** tax-code table, registration flags, `deductibleCents`, entry UI/OCR/chat, returns; **2c** opt-in restatement.
3. **Bills**: **3a** additive schema (`postingMode`, `partial|draft`, lines, payments, `matchedBillId`) + export/deletion registry; **3b+3c shipped together** (an `at_entry` bill must never exist while the balance sheet, aging, Home/Upcoming/CPA/`cpa-review` and BAS readers still ignore it — `at_entry` is also behind a tenant flag that stays off until this PR is deployed): `lib/purchases`, routes, legacy-hole fixes, all readers; **3d** Bills UI + chat skills + bank-match.
4. **Employee profile + pay frequency**: 4a schema (+ `payDate`, `payFrequency`, anchors, PII tables), 4b API/audit/privacy plumbing, 4c UI + display map, 4d payDate switch of statutory reports with fixtures.
5. **Inventory**: 5A items/purchases/on-hand (incl. the COGS/shrinkage accounts); 5B sales/COGS/reports.

## 8. Testing & verification

- Fake-ledger suite (extends `fake-ledger-db.ts`): every bill/payment/void/amend/stock transition balances, is idempotent, respects `assertPeriodOpen`; assert computed values (P&L, balance sheet AP, BAS 1B/G10/G11, ITC) not shapes.
- Property test: random sequences of bill/pay/partial/void never give Σdr≠Σcr, `2000 balance ≠ Σ(open+partial at_entry bills' total − paid)` per tenant, or `paidCents > totalCents`.
- Wiring tests at the route level with a mutation check on the call site; guard: balance-sheet AP never counts one bill twice.
- Tax golden rows per jurisdiction (AU $110.00 → $10.00; $0.99 → $0.09; CA GST+PST per-component rounding; meals 50%); mixed typed/untyped BAS and ITC fixtures; non-registered tenant gets no credit.
- Legacy: an `at_payment` bill created before the change pays exactly as before except now gated by the period check and with a `sourceId`.
- Inventory: WAC golden sequence (buy 10@$5, 10@$7, sell 5 → COGS $30), exact zero at qty 0, negative-stock true-up, invoice void.
- Employee: sensitive values absent from API responses, logs, scrubbed payloads, export (assert with the scrubber test); edit does not touch processed runs; STP/BAS payDate fixture across a quarter boundary.
- Prod e2e on maya (CA), alex (US), sydney (AU) with tagged fixtures created and deleted, never acting on seeded data; locale proven via h1 before reading catalogs; i18n verified in a browser.

## 9. Risks / open points

- Gross-vs-net restatement is user-visible; mitigated by opt-in, preview, and a note on reports.
- Converting legacy open `at_payment` bills to `at_entry` is optional in v1.
- Cash-basis P&L/estimate view of `at_entry` bills is deferred (toggle disabled while such bills exist); BAS cash-GST is not deferred.
- Bank-match heuristics are best-effort; a one-tap "this payment is for bill X" merge is the fallback.
- AU tax-return row mapping for COGS/closing stock and `3900` account collision verified in the plan's first task for those PRs.
- `AbBill.status` values are widened with `partial|draft`; every reader is enumerated in 3c.
- Schema deploy race: keep each schema PR minimal and merge promptly.

## 10. Calls made in this document (owner to confirm or override)

1. Payroll **journal stays on `periodEnd`**; statutory reports use `payDate` (§5.5).
2. Restatement skips closed periods; it is opt-in per tax year (§5.1).
3. COGS `5990` / shrinkage `5995` on US/CA, existing `5000` on AU/UK (§3).
4. `gstRegistered = null` posts gross and prompts (§5.1).
5. Legacy balance-sheet dates do not move; `billDate` applies to new bills only (§5.2).
6. Foreign-currency bills rejected in v1; cash-basis P&L view of `at_entry` bills deferred (§2, §5.2).
