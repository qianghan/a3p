# Bills (AP), tax codes, one-step categorisation, inventory & payroll completeness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Every task is test-first: write the failing test, see it fail for the right reason, implement, see it pass.

**Goal:** Close the seven AU-tester findings for US, CA and AU: a real payables flow, tax codes with recoverable-tax handling, one-step categorisation, small-business inventory, and complete employee records with pay frequency.

**Spec:** `docs/superpowers/specs/2026-11-13-ap-tax-codes-inventory-payroll-design.md` (rev 3, reviewed twice). Section references (§) point there. Where this plan and the spec disagree, stop and fix the spec first.

**Architecture in one line:** one posting library family (`lib/ledger-writer`, `lib/tax-codes`, `lib/purchases`, `lib/inventory`, `lib/employees`) over the existing journal; reports read the journal, tables only attribute.

## Global constraints (apply to every PR)

- Production serves **Next route handlers** (`apps/web-next/src/app/api/v1/...`) returning `{success, data}`, tenant from `safeResolveAgentbookTenant`; cross-tenant ids → 404. Never rely on Express plugin backends.
- **Additive schema only** (nullable/defaulted columns, new tables). Remote builds run `prisma db push`; each schema change is its own small PR, merged promptly, never combined with feature code that needs it unless the PR is the one that deploys it. Verify against an **isolated local DB**, never `--accept-data-loss` on a shared one. Never run schema commands with credentials from the removed naap/Neon endpoints.
- Every posting: balanced entry, unique `(tenantId, sourceType, sourceId)`, closed-period check, P2002 = replay-or-retry. Money is integer cents.
- No `git stash`; no direct pushes to `main`; PR per task group; `main` is branch-protected (Quality Gates + CodeQL). Use a fresh worktree off `origin/main` per PR (`git checkout -B <branch> origin/main`), run `npm install` in new worktrees.
- Prod deploys: local `vercel build` + `--prebuilt` per `agentbook/skills/deployment.md`; verify `.vercel/project.json` is `a3p-plugin-build`; check the newest prod deployment postdates the merge.
- i18n: all user-visible strings through `useT`, keys in en / fr-CA / zh-CN (U+2019 apostrophes in fr-CA); key names are UI text (no `a11y_close`-style names); verify in a **browser** (Maya renders French). Brand names get no catalog key.
- Chat parity: each new capability ships a chat skill and passes the parity guard.
- Assertions check **computed values**, not shapes. Mutation-check each wiring by reverting the call site on a file copy.
- Prod e2e only with tagged fixtures created and deleted by the test, on personas maya (CA), alex (US), sydney (AU); never act on seeded data; read catalog locale only after an `/app` page loaded and prove it against the h1.
- After each merge: confirm auto-deploy finished, then run that PR's prod verification before starting the next PR.

## Dependency map

```
PR1 categorisation ─────────────────────────────────────────┐ (independent)
PR2a ledger-writer + tax-aware repost ─► PR2b tax codes ─► PR2c restatement
PR2a ─► PR3a bill schema ─► PR3bc purchases+readers ─► PR3d UI/chat/bank-match
PR4a employee schema ─► 4b API/privacy ─► 4c UI ─► 4d payDate switch
PR3bc ─► PR5A inventory ─► PR5B COGS/reports        (PR4 independent of PR2/3)
```

Suggested order: PR1 → PR2a → PR2b → PR3a → PR3bc → PR3d → PR2c → PR4a–d → PR5A → PR5B.

---

## PR 1 — One-step categorisation (spec §5.3)

Files: `apps/web-next/src/app/api/v1/agentbook-expense/expenses/route.ts` (+ `[id]/` confirm/categorize routes), `apps/web-next/src/app/app/capture/page.tsx`, `apps/web-next/src/app/app/_lib/api.ts`, web expense form in `plugins/agentbook-expense/frontend/src/pages/`, `AbVendor`/`AbPattern` suggestion code, catalogs.

- [ ] **1.1 Characterise today's flow.** Test the current two-call path (`categorizeDoc` then `confirmDoc`) so behaviour is pinned: category set → `backfillExpenseJournalEntry` moves suspense debit; no category → `6999`.
- [ ] **1.2 Failing tests** for `POST /expenses` accepting `{ categoryId, confirm: true }` in one request: exactly one journal entry, on the real category, never touching `6999`; replay with the same `idempotencyKey` → still one entry; category belonging to another tenant → 404/422.
- [ ] **1.3 Implement** the single-request path using the existing posting helper (no new writer). Suggestion order: `AbVendor.defaultCategoryId`/`AbPattern` above threshold → LLM constrained to the tenant's active expense accounts → none (stay on `6999`). Confirming a suggestion raises its confidence; changing it records a correction through the existing pattern store (**not** `AbUserMemory`).
- [ ] **1.4 Capture review (`/app/capture`)**: category shown as a prefilled field with confidence badge + one-tap picker; one Save call. Update `api.ts` (typed client) **and add a fetch-mocking test of the client function** (page tests that mock the module give no coverage of fetch bugs).
- [ ] **1.5 Web expense form**: category required-prefilled, same endpoint.
- [ ] **1.6 Review queue**: only low-confidence rows are `pending_review`; assert a high-confidence confirmed row is not queued.
- [ ] **1.7 i18n + e2e**: new strings in three catalogs; prod e2e on all three personas: capture with a prefilled category → one expense, correct category, books unchanged after cleanup.
- Done when: no normal entry lands in `6999`; one request per save; prod e2e green.

## PR 2a — Ledger writer extraction + tax-aware repost (spec §3, §5.1 prerequisite)

Files: `apps/web-next/src/lib/agentbook-expense-ledger.ts`, new `apps/web-next/src/lib/ledger-writer.ts`, `lib/__tests__/fake-ledger-db.ts`, `lib/__tests__/agentbook-expense-ledger.test.ts`.

- [ ] **2a.1 Failing tests** pinning today's behaviour for 2-line, 3-line-with-tax-liability and split entries (edit amount, change category, delete, reclassify from suspense) so the refactor is provably neutral.
- [ ] **2a.2 Extract** `appendBalancedEntry`, `assertPeriodOpen` into `lib/ledger-writer.ts` and export them. Changes: catch P2002 and return the existing entry when the payload matches (else throw `LedgerKeyConflict`); derive the fiscal period in **UTC**; keep the expense lib importing from it. No behaviour change for existing callers (tests from 2a.1 stay green).
- [ ] **2a.3 Failing tests** for a registrant-shaped entry `DR category(net+nonrecoverable) | DR 2100(recoverable) | CR 1000(gross)`: amount edit, category change, delete, uncategorised→categorised reclass must each produce balanced results and correct P&L figures.
- [ ] **2a.4 Implement** the tax-aware repost (recompute the split from `amountCents`, `taxCode`, `recoverableTaxCents`) and extend `reclassifyFromSuspense` to tolerate a 2100 line. Untyped rows keep the old path untouched.
- [ ] **2a.5 Gate:** nothing writes a 3-line expense entry yet — this PR only makes it safe. Mutation-check: revert the repost branch → 2a.3 tests fail.
- Done when: all pre-existing ledger tests green unchanged; new shape tests green; no production behaviour change (verify on prod with one edit/delete of a tagged expense per persona).

## PR 2b — Tax codes (spec §5.1)

Files: new `packages/agentbook-jurisdictions/src/{au,ca,us}/tax-codes.ts` (+ index + tests), `lib/tax-codes.ts` (thin app adapter), `packages/database/prisma/schema.prisma` (+ `AbExpense.taxCode`, `recoverableTaxCents`; `AbTenantConfig.qstRegistered`, `gstReportingBasis`; `AbVendor.defaultTaxCode`), expense routes, OCR (`lib/agentbook-receipt-ocr.ts`, `lib/mobile/from-receipt.ts`), BAS/CA returns, `lib/agentbook-deduction-rules.ts`, capture + web forms, chat skill parsing, catalogs.

- [ ] **2b.1 Schema PR first** (additive columns only), isolated-DB verification, merge, confirm deployed.
- [ ] **2b.2 Failing golden tests** for `computeLineTax`: AU inclusive $110.00 → $10.00, $0.99 → $0.09, exclusive 10%; CAP; FRE/INP/NTR zero credit; CA GST/HST/GST+PST per-component rounding, QST only when `qstRegistered`, meals fraction 0.5; US never recoverable; negative (refund) symmetry; unregistered → recoverable 0. Rates come from the existing `sales-tax.ts` providers (assert no duplicated rate literals).
- [ ] **2b.3 Implement** the table + function in `packages/agentbook-jurisdictions`, exposed through `lib/tax-codes.ts`.
- [ ] **2b.4 Registration flags**: expose `gstRegistered` (existing), `qstRegistered`, `gstReportingBasis` in Business Profile settings (single editor for these, like jurisdiction/currency); `null` registration shows the prompt and posts gross.
- [ ] **2b.5 Posting**: expense create/amend route computes tax via the table; for recoverable-tax tenants writes the 3-line entry through `lib/ledger-writer` (PR 2a shapes); others unchanged. Printed OCR tax wins within 2¢, else flag for review.
- [ ] **2b.6 `deductibleCents` accessor + migration of table readers.** Grep every reader of `AbExpense.amountCents` in deductions/category/vendor reports (`agentbook-deduction-rules.ts:94,159,214` and the rest the grep finds); add a guard test that fails on direct `amountCents` use in those modules.
- [ ] **2b.7 Returns**: BAS 1B/G10/G11 and CA ITC sum `recoverableTaxCents` for typed rows, `taxAmountCents` for untyped; `gstRegistered === false` → 1B 0; the `gstReportingBasis` cash path is built and tested in PR 3bc (no skipped placeholder test here). Golden mixed fixture: typed + untyped + non-registrant.
- [ ] **2b.8 Entry UI**: tax row (code chip, amount, inclusive/exclusive toggle) in capture review, web expense form; hidden for US without tax and for `gstRegistered === false`; OCR keeps `tax_cents` and adds `taxLabel`; chat parses "$110 incl GST".
- [ ] **2b.9 i18n, e2e** (sydney: $110 incl GST → BAS 1B +$10.00, expense net $100.00, P&L net; maya: GST+QST; alex: no tax row), mutation-check wiring, prod verify incl. editing and deleting the typed expense.
- Done when: BAS 1B/CA ITC match hand-computed values; edit/delete of typed expenses work on prod; no table reader uses gross for deductions.

## PR 3a — Bill schema (spec §5.2.0)

- [ ] **3a.1** Additive columns on `AbBill` (`vendorId, billNumber, billDate, subtotalCents, taxCents, recoverableTaxCents, paidCents, currency, postingMode default 'at_payment', revision, idempotencyKey, receiptUrl, deletedAt`); new `AbBillLine`, `AbBillPayment`; `AbBankTransaction.matchedBillId`; indexes `(tenantId,status,dueDate)`, `(tenantId,billDate)`, `(tenantId,deletedAt)`, lines/payments by `billId`, `(tenantId,date)`.
- [ ] **3a.2** Add `AbBill`, `AbBillLine`, `AbBillPayment` (and the already-missing `AbEmployee`, `AbPayRun`, `AbPayStub`) to `me/export` and the tenant deletion registry (`lib/agentbook-tenant-data-models.ts`); extend the export/deletion tests.
- [ ] **3a.3** Isolated-DB verify, merge, confirm existing bills still list/pay unchanged on prod.

## PR 3bc — Purchases engine + every reader (spec §5.2) — one deploy

Files: new `lib/purchases.ts` (+ `__tests__`), `agentbook-expense/bills/route.ts`, `bills/[id]/route.ts`, new `bills/[id]/payments`, `lib/balance-sheet.ts`, `reports/balance-sheet`, `reports/ap-aging`, `lib/mobile/{home,upcoming}.ts`, `lib/cpa-run.ts`, `plugins/agentbook-core/backend/src/server.ts` (`manage-bills`, `cpa-review`), `agentbook-tax/au/bas-return`, fixtures/tests listed in spec §5.2, feature flag `purchases_at_entry` (off).

- [ ] **3bc.1 Failing tests (fake-ledger)** for `postBill`/`payBill`/`partialPay`/`voidBill`/`voidPayment`/`amendBill`: balanced, idempotent on replay, sourceType/sourceId exactly per the spec table, closed-period refusal, overpayment 422, concurrent payments (optimistic `updateMany` on `paidCents`) never overpay, amend revision race retries.
- [ ] **3bc.2 Property test**: random sequences of bill/pay/partial/void keep Σdr = Σcr, `2000 balance == Σ(open+partial at_entry totals − paid)` per tenant, `paidCents ≤ totalCents`.
- [ ] **3bc.3 Implement `lib/purchases.ts`** on `lib/ledger-writer` + `lib/tax-codes` + (later) `lib/inventory`. Bills create: reject non-tenant currency (422 `bill_currency_unsupported`); category via PR 1's suggestion; per-line tax via PR 2b.
- [ ] **3bc.4 Legacy path preserved**: `postingMode='at_payment'` rows and cash-basis tenants pay exactly as before (`DR expense / CR 1000`) but through the writer: real `sourceId` for new payments, period gate, no silent fallback account (use `ensureChartOfAccounts`; fail the request instead of marking paid without an entry). Close legacy holes: `DELETE` of a paid bill rejected (or payment voided first).
- [ ] **3bc.5 Update every reader** (spec §5.2 list): unpaid = `open|partial` in bills GET (`overdue`, `openCents`), aging, Home, Upcoming, CPA run, `manage-bills`, **`cpa-review`**, fixtures. Balance sheet: `at_payment` keeps derived AP + retained-earnings offset; `at_entry` reads journal `2000`, no offset, dated by `billDate`; legacy `createdAt` dating unchanged. Guard test asserts `assets == liabilities + equity` for mixed sets and no bill counted twice.
- [ ] **3bc.6 BAS cash-GST**: `gstReportingBasis='cash'` counts bill amounts by `AbBillPayment.date` pro-rata; accrual counts by `billDate`. Golden fixtures for both bases (partial payments, quarter boundary).
- [ ] **3bc.7 Docs/expense list `PurchaseView`**: one row per bill with Due/Paid badge alongside expenses.
- [ ] **3bc.8 `?basis=cash` guard**: disabled with a banner while open `at_entry` bills exist; test.
- [ ] **3bc.9 Wiring tests at route level** + mutation check on each route's call into `lib/purchases`; e2e (alex/maya/sydney): create bill (flag on for the test tenant) → balance sheet shows AP → pay → AP 0, cash down, **no expense row added**, P&L expense counted once; legacy bill created before the PR pays as before.
- [ ] **3bc.10** Deploy with flag off, verify legacy bills unchanged, then enable the flag for persona tenants, run e2e, then default on for accrual tenants.
- Done when: AP appears in the ledger on bill date; paid bill never double counts; balance sheet balances for mixed legacy/new data.

## PR 3d — Bills UI, chat skills, bank match (spec §5.2 surfaces)

- [ ] **3d.1** Web Bills page (Open/Overdue/Paid, aging buckets, add/edit/pay/partial/void) in the expense plugin frontend; rebuild + **commit** the UMD bundle to `apps/web-next/public/cdn/plugins/...`; verify in a real browser.
- [ ] **3d.2** Mobile Capture "Pay later" toggle with due date (offline queue + idempotency key), Home bills-due alert extended to `partial`.
- [ ] **3d.3** Chat skills `record-bill`, `pay-bill`, `query-payables` (replace the `manage-bills` internals with `lib/purchases` calls; keep the manifest); parity guard; replay a real transcript on prod after merge.
- [ ] **3d.4** Bank-match: bill candidate in the *proposal* path (not `agentbook-bank-match.ts`, which only applies), `applyBillMatch` records a payment, set `matchedBillId`; a bank debit for a paid bill never creates an expense; one-tap "this is for bill X" merge fallback.
- [ ] **3d.5** i18n (three locales), a11y checks, e2e on the three personas.

## PR 2c — Opt-in tax restatement (spec §5.1)

- [ ] **2c.1 Failing tests**: restating a legacy gross expense = amend-reversal + 3-line repost under the existing `expense_amend*` keys; second run is a no-op; closed-period rows are skipped and listed; later delete/amend still correct; cash-basis view consistent.
- [ ] **2c.2 Implement** preview endpoint (P&L delta, row counts, skipped) + apply endpoint, Settings UI per tax year, report footnote until accepted.
- [ ] **2c.3** Prod verify on a tagged fixture only (never restate seeded data).

## PR 4 — Employee profile, pay frequency, payDate (spec §5.5)

- [ ] **4a Schema (own PR):** `AbEmployee` additions (common + AU/CA/US), `payAnchorDate`; new `AbEmployeeSensitive`, `AbEmployeeChange`; `AbPayRun.payDate`, `payFrequency`; verify isolated DB; merge; confirm deployed.
- [ ] **4b API + privacy (before any UI):**
  - Failing tests: sensitive values absent from every response, `me/export`, logs and scrubbed payloads; `reveal` is audited, rate-limited and role-gated; unknown keys rejected; per-jurisdiction validation (AU TFN format, CA SIN checksum, US masked SSN last4).
  - Encryption helper modelled on `lib/agentbook-bank-token.ts` AES-256-GCM with `EMPLOYEE_PII_ENCRYPTION_KEY`, **throws in production/preview if the key is missing** (no zero-key fallback; test it).
  - Scrubber additions (`superFundUsi`, `superMemberNumber`, `taxIdEnc`, `bankAccountEnc`, `td1*`, `routingLabel`) + `scrub.test.ts`; export/deletion registry entries; audit callers of `PUT employees/[id]` before flipping to strict validation.
  - New `GET employees/[id]` (masked), zod `PUT` (tenant-scoped update), `POST employees/[id]/reveal`, `AbEmployeeChange` writes (no sensitive values).
- [ ] **4c UI:** employee detail/edit (Personal, Pay, Tax, Banking, Super/Benefits by market) linked from the payroll list; frequency display map (Fortnightly for AU; Bi-weekly US/CA) in the three catalogs **and** the chat reply catalog; frequency selectable on edit; pay-run draft generation per frequency group from `payAnchorDate` (weekly 7d, fortnightly 14d, semimonthly 1st–15th/16th–end, monthly); `payDate` and `payFrequency` stored on the run. Browser-verify in French and Chinese.
- [ ] **4d payDate switch:** enumerate every `periodEnd` consumer by grep (STP `au/stp`, BAS W1/W2 `au/bas-return`, `year-end/route.ts`, year-end and tax-deposits PDFs, deposits), switch statutory reports to `payDate ?? periodEnd`, **keep the payroll journal date on `periodEnd`**, add report-footer wording; regression fixture crossing a BAS-quarter and a year boundary asserting each consumer's bucket; processed-run snapshot test.
- [ ] **4e** Chat skills for employee/pay-frequency questions through the parity guard; prod e2e on sydney (AU fields, fortnightly run) and maya/alex (labels, edit rate applies to next draft only).

## PR 5A — Inventory: items, purchases, on-hand (spec §5.4)

- [ ] **5A.1 Account roles:** verify `1500`, `3900`, `5990`, `5995` are free in all four charts; add via `ensureChartOfAccounts`; `resolveAccountByRole('inventory'|'cogs'|'shrinkage'|'opening_equity')` (AU/UK `cogs` = `5000`, US/CA = `5990`); set `taxCategory` mappings; confirm the AU tax-return rows for COGS/closing stock in the AU schedule code.
- [ ] **5A.2 Schema (own PR):** `AbInventoryItem`, `AbStockMovement` (value in integer cents), `AbBillLine.itemId` (already present), tenant flag `trackInventory`, `AbInvoiceLine.itemId`.
- [ ] **5A.3 Failing tests (fake-ledger):** purchase via a bill line debits `1500` and adds qty/value; WAC golden sequence (buy 10@$5, buy 10@$7, sell 5 → COGS $30 with value-based relief); exact zero value at qty 0; negative-stock then purchase → `stock_adjust` true-up; opening stock balances to `3900`; period gate; P2002 replay.
- [ ] **5A.4 Implement `lib/inventory.ts`**, items CRUD routes, stock-on-hand + movement-ledger reports, low-stock alert, `trackInventory` toggle (offered to merchant/retail business types; gated on the flag, not `businessType` alone).
- [ ] **5A.5** Items UI, chat skill (`query-stock`), i18n, e2e on one persona per market.

## PR 5B — Inventory: sales, COGS, reports

- [ ] **5B.1 Failing tests:** invoice creation with item lines posts `stock_sale` (`DR cogs | CR 1500`, `sourceId` invoice line id) once; invoice void posts `stock_sale_void`; edit invoice qty reverses/reposts; negative stock path; COGS appears on the P&L per jurisdiction account.
- [ ] **5B.2 Implement** the hook where invoices post revenue (creation), invoice-line item picker, COGS-by-period report, shrinkage adjustment flow.
- [ ] **5B.3** Mutation-check wiring at the invoice route; i18n; e2e (sale reduces stock, COGS correct, void restores).

## Cross-cutting acceptance

- [ ] Full journal property test (bills + inventory + tax + payroll entries) green in CI.
- [ ] Docs updated: `agentbook/skills/{architecture,product,workflows}.md`, `CLAUDE.md` rules learned, `agentbook/user-story.md`.
- [ ] Memory note per shipped PR group (status, lessons).
- [ ] Final prod pass per persona: bill → pay → BAS/GST return; typed expense edit/delete; fortnightly pay run + STP bucket; inventory sale.

## Owner calls to confirm before PR 4d and PR 2c (spec §10)

1. Payroll journal stays on `periodEnd` while statutory reports use `payDate`.
2. Restatement skips closed periods.
3. COGS `5990` / shrinkage `5995` for US/CA.
4. `gstRegistered = null` posts gross and prompts.
5. Legacy balance-sheet dating is unchanged.
6. Foreign-currency bills rejected in v1; cash-basis P&L view of `at_entry` bills deferred.
