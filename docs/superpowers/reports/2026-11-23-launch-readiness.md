# AgentBook launch readiness — 2026-11-23

Scope: the AP / tax codes / inventory / payroll programme (plan `docs/superpowers/plans/2026-11-13-ap-tax-codes-inventory-payroll.md`), evaluated on top of the 2026-07-31 rev 3 assessment and the 2026-10-23 mobile redesign scorecard.
Evidence base: code on origin/main `c2a1db85`, read through grep and spot reads, with paths relative to `apps/web-next/src` unless they say otherwise. No tests were run. **No prod checks were made in this pass**, so every item marked *unverified* still needs a read-only prod confirmation.

## Verdicts

| Market | Verdict | What decides it |
|---|---|---|
| **US** | **CONDITIONAL GO** (bookkeeping, bills, inventory). **NO-GO for payroll.** | (1) Federal withholding applies the brackets to gross pay with no standard deduction, and state tax is a flat top-marginal rate on all wages (CA 13.3%). Every US pay stub over-withholds (F2). (2) A double-submitted pay run posts twice (F1). (3) Bills run at_payment until the owner enables `purchases_at_entry`: no part payments, and A/P is derived rather than in the ledger (F8). (4) Daily-pulse auto-expenses have no journal entry (F5). |
| **CA** | **NO-GO** for GST/HST filing and payroll. CONDITIONAL GO for bookkeeping. | (1) Untyped meals/PST/QST rows put their full tax into GST/HST line 108, which over-claims ITCs on a return users file (F3). (2) Federal withholding has no basic personal amount and CPP has no $3,500 exemption, so every employee is over-withheld (F2). (3) Pay-run double-post (F1). (4) Expenses are stored as 'USD' on most paths and OCR can't return anything outside USD/CAD (F9, labels only). (5) Chat plan chrome is English in fr-CA (F11). |
| **AU** | **CONDITIONAL GO** | (1) Untyped rows put their full GST into BAS 1B. The impact is smaller than in CA because AU has no PST/QST and the 50% meals rule rarely applies, but the over-claim still exists (F3). (2) PAYG and super look reasonable, but the pay-run double-post and the deposit with no journal still apply (F1, F6). (3) OCR can never return AUD and most paths store 'USD' (F9). (4) Bills at_payment (F8). |

## Findings by severity

Critical 2 · High 6 · Medium 8 · Low 4 (20 in total).

| ID | Sev | Markets | What breaks for a user | Evidence | Fix |
|---|---|---|---|---|---|
| F1 | Critical | US, CA, AU | A double-click or retry on "process pay run" posts the payroll journal twice and doubles the 941/PAYG/SG/940 deposit accruals. The "already processed" check runs before the transaction and the final update is keyed on `{id}` only. | `app/api/v1/agentbook-payroll/pay-runs/[id]/process/route.ts:33-37`, `:148` (update `where: { id }`) | S |
| F2 | Critical | US, CA | Withholding is wrong on every stub. CA federal has no basic personal amount (about $2.4k/yr extra per employee) and CPP is 5.95% of full gross with no $3,500 exemption. US federal applies 2024 brackets to gross with no standard deduction, and state tax is a flat top-marginal rate on all wages; a state missing from the table gets $0. | `lib/payroll-engine.ts:45-49,86-98` (US), `:102-105,174,181-183` (CA) | M |
| F3 | High | CA (AU lower) | ITC over-claim on a filed return. A row with no tax code puts its full tax paid into line 108 / 1B, skipping the 50% meals rule and the PST/QST split. Restatement (2c) fixes only the rows a user opts to restate. | `packages/agentbook-jurisdictions/src/ca/gst-hst-return.ts:96-97`; `packages/agentbook-jurisdictions/src/au/bas-return.ts:93-94`; `app/api/v1/agentbook-tax/ca/gst-hst-return/route.ts:76` | M |
| F4 | High | US, CA, AU | Pay-run journals are written straight to `abJournalEntry` and bypass the ledger writer's period lock, so payroll can post into a closed or filed period. | `pay-runs/[id]/process/route.ts:82` | S |
| F5 | High | US, CA | The daily-pulse cron auto-records matched bank debits as expenses with no journal entry, tax code or currency. The ledger and P&L then disagree. | `app/api/v1/agentbook/cron/daily-pulse/route.ts:82-95` | S |
| F6 | High | US, CA, AU | Marking a tax deposit paid changes only its status. Payroll Liabilities and Super Payable never clear and cash is overstated on the balance sheet. | `app/api/v1/agentbook-payroll/tax-deposits/route.ts:38` | S |
| F7 | High | US, CA, AU | With no salary account or no code-1000 cash account, the run is still marked paid but no journal is written. The fallback account is the first active expense account, which is likely COGS 5000. | `pay-runs/[id]/process/route.ts:41-43,54` | S |
| F8 | High (config) | US, CA, AU | `purchases_at_entry` is OFF for every tenant, so every bill is at_payment: no part payments (both matchers refuse partial debits), A/P is derived rather than in the ledger, and the 3a/3bc post evidence is still pending. | `lib/purchases-flag.ts` (fails closed); `app/api/v1/agentbook-expense/bills/route.ts:129,201`; `lib/agentbook-payment-matcher.ts:92,273`; `lib/balance-sheet.ts:10,21` | owner |
| F9 | Medium | CA, AU | Expenses are stored as 'USD' on the web API default, chat record-expense, per-diem, Telegram, CSV and CC import, and home-office. The OCR prompt allows only USD and CAD. No total changes (nothing converts or filters by currency), but the CPA portal, Telegram cards and backup export show the wrong currency. | `app/api/v1/agentbook-expense/expenses/route.ts:309`; `lib/agentbook-bot-agent.ts:3230,3254,3442`; `per-diem/route.ts:166,190`; `telegram/webhook/route.ts:6103`; `lib/agentbook-receipt-ocr.ts:174,217`; readers at `cpa-portal/[token]/dashboard/route.ts:232`, `lib/agentbook-backup.ts:148` | M |
| F10 | Medium | US, CA, AU | `EMPLOYEE_PII_ENCRYPTION_KEY` is unset in prod (per brief, *unverified on prod*). Saving a tax ID, bank account or super number and the audited reveal return 503 `PII_KEY_UNCONFIGURED`. Adding an employee and other edits still work, so year-end slips have no tax ID. | `lib/agentbook-employee-pii.ts:47-55`; `employees/[id]/route.ts:106-115`; `employees/[id]/reveal/route.ts:62` | owner |
| F11 | Medium | CA (fr), zh | The chat plan chrome ("Here's my plan:", "(irreversible)", "Proceed? (yes/no)") is English literals. | `plugins/agentbook-core/backend/src/agent-planner.ts:279,281,284` | S |
| F12 | Medium | US, CA, AU | Cash-basis tenants get accrual numbers outside P&L and the balance sheet: annual summary, income-by-client, tax summary, quarterly comparison, cashflow and invoices. | `app/api/v1/agentbook-tax/reports/annual-summary/route.ts:31`; only `reports/pnl`, `reports/balance-sheet` and `lib/cash-basis-guard.ts` read basis | M |
| F13 | Medium | US, CA, AU | Deleting an employee hard-deletes the encrypted record, so a mid-year leaver has no SSN/SIN/TFN for their W-2/T4/STP. What year-end does without the ID is *unverified*. | `employees/[id]/route.ts:174` | S |
| F14 | Medium | US, CA, AU | The chat/MCP parity guard covers bills only. Nothing guards or exempts inventory, COGS, employee or pay-frequency skills. | `plugins/agentbook-core/backend/src/__tests__/bill-chat-routing.test.ts:20` | S |
| F15 | Medium | US, CA, AU | "Pay later" on a photo capture saves an ordinary expense, not a bill, and the toggle is shown anyway. | `app/app/capture/page.tsx:293,450` | M |
| F16 | Medium | US, CA, AU | The legacy bill PUT (at_payment) stores `amountCents` unvalidated, so negative or fractional amounts are later posted at payment. | `app/api/v1/agentbook-expense/bills/[id]/route.ts:73` | S |
| F17 | Low | CA, zh | Payroll tab labels are English literals, and the inventory unit "each" is missing from fr.json. | `app/(dashboard)/payroll/page.tsx:203-207`; `plugins/agentbook-expense/frontend/src/pages/Items.tsx:51,74,98` | S |
| F18 | Low | US, CA | The ABN field shows for every country, with an untranslated label. The invoice PDF does gate it by jurisdiction. | `components/settings/AgentBookSettingsPanel.tsx:2144-2150` | S |
| F19 | Low | UK | UK tenants fall through to the US chart (owner call O3 deviation). | `lib/agentbook-chart-of-accounts.ts:22-26,78` | M |
| F20 | Low | n/a | Neon/livepeer leftovers: `reset-preview-db.yml` (NEON_* secrets) and `migration-check.yml:67-73` (review request to `@livepeer/core`). | `.github/workflows/` | S |

Process note, not a product defect: the per-PR full-suite gate is load-sensitive locally. It is handled by the accepted-timeout gate (#655).

## Verified working (code read)

- Every route reviewed in payroll, bills and inventory resolves the tenant through `safeResolveAgentbookTenant` and scopes its queries by tenantId.
- Bills:
  - DELETE goes through `voidBill` and refuses paid bills.
  - Voiding a payment posts a mirror entry.
  - PATCH reverses the old entry and re-posts.
  - PUT refuses at_entry and paid bills.
- Pay-run journals balance (gross = net + withholdings; the AU SG pair is additive). Only draft runs can be deleted.
- AU PAYG uses the $18,200 threshold and SG is 12%. Both are reasonable approximations.
- An unknown CA province falls back to Ontario instead of $0.
- Inventory item delete is soft and keeps movement and journal history. `loadItem` blocks cross-tenant use.
- The `purchases_at_entry` flag fails closed and applies to accrual tenants only. Its rollout script defaults to a dry run.
- Mobile from-receipt uses the tenant's currency.
- Not checked: the money logic in tax-code routes, COGS and restatement beyond tenant scoping. The PR #665 evidence for 3d and 2c is not on main (there are no `pr3d-*` or `pr2c-*` reports under `reports/scorecards/`), so it is *unverified*.

## Owner / config actions

1. Run `agentbook/enable-purchases-at-entry.ts` (dry run, then `--apply`), then the 3a/3bc post scorecards.
2. Set `EMPLOYEE_PII_ENCRYPTION_KEY` in Vercel (all environments) and redeploy.
3. Merge #665 (the 3d/2c LAUNCH-READY evidence) and finish the cross-PR journey specs. The programme scorecard is 9/26.
4. Until F1/F2 ship, hide payroll for US and CA, or label it "estimate, verify with your provider". Until F3 ships, block CA GST/HST filing behind a "restate untyped rows" prompt.
5. Remove or rewrite the Neon workflows (F20).

Fix order for engineering: F1, F4, F7 (one PR on the process route), then F2, F3, F5, F6.
