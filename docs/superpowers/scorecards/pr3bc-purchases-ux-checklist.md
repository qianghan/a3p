# PR 3bc — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr3bc-purchases-ux-postdeploy.md`.

- [x] Mobile Docs bill rows and the bill sheet are built from `_kit` primitives with `tokens.color.*` and `moneyText`; the Due/Paid badge reads its label through `useT` (`apps/web-next/src/app/app/docs/_components/BillItem.tsx`, `docs-page.test.tsx`).
- [x] One row per bill: the list merges `GET agentbook-expense/purchases` bill rows with expenses, ordered deterministically; a paid bill shows the Paid badge and is not an expense row (`purchases-view.test.ts`, `purchases/__tests__/route.test.ts`).
- [x] Overdue is computed in the tenant timezone, the same day boundary Home and Upcoming use.
- [x] Desktop Bills page surfaces pay failures (422 period_closed, 422 ledger_account_missing incl. fr-CA, 409 conflict) with a specific message, not a silent no-op (`bills-pay-error.test.tsx`).
- [x] Reports: `?basis=cash` is disabled with a localized banner while open at_entry bills exist (`reports-cash-basis-banner.test.tsx`); Settings shows the matching basis note (`basis-open-bills-note.test.tsx`).
- [x] BAS / CA return footnote states which basis bills were counted on (`sales-tax-return-basis.test.tsx`).
- [x] Every new user-visible string goes through `useT` with keys in en, fr-CA and zh-CN (core_ui, expenses_ui, mobile, tax_ui), enforced by the i18n catalog / mobile-keys guards; fr-CA uses U+2019 apostrophes; key names are UI text.
- [x] Error codes from lib/purchases (`overpayment`, `bill_has_payments`, `period_closed`, `bill_amend_required`, `payment_not_found`) are returned as `{ success: false, code }` with 4xx, so every surface can show a specific message.
