# PR 2b — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr2b-tax-codes-ux-postdeploy.md`.

- [x] Mobile capture tax row is built from kit primitives: code chips are `_kit` `Chip` (aria-pressed), colours/borders from `tokens.color.*`, money via `moneyText` (`apps/web-next/src/app/app/capture/_components/TaxRow.tsx`); the mode toggle is a 44 px radiogroup like the other capture segments.
- [x] Every new user-visible string goes through `useT`; keys exist in en, fr-CA and zh-CN (mobile, expenses_ui, core_ui, tax_ui, skill catalogs — 25 `tax_*` mobile keys in each locale), enforced by the i18n catalog / mobile-keys / unwired guards; fr-CA uses U+2019 apostrophes.
- [x] Rate-code acronyms (GST, HST, GST + QST) render as codes; worded codes (GST-free, input-taxed, no GST, capital, zero-rated, exempt, out of scope) are translated (`useTaxCodeLabel`, `tax-row-copy.test.ts`).
- [x] Hidden where it must be: US tenants and `gstRegistered === false` get `visible: false` from the one server view (`lib/expense-tax-row.ts`), on capture and the web New Expense form alike.
- [x] Unknown registration (`null`) shows a one-line prompt linking to Business Profile, the single editor for `gstRegistered`/`qstRegistered`/`gstReportingBasis`.
- [x] The web New Expense tax row and the capture row render from the same `GET agentbook-expense/tax-codes` preview, so the displayed tax/total equals what is booked.
- [x] Error paths: a closed period surfaces the dedicated `period_closed` message on capture, not a generic failure; tax-codes errors surface on New Expense.
- [x] BAS shows G10/G11 and the CA return shows the QST ITR line using the existing return-line component (`sales-tax-return-lines.test.tsx`).
