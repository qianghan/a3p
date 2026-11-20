# PR 4d — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr4d-paydate-ux-postdeploy.md`.

- [x] No new screen: one footer line on the payroll Tax deposits / Year-end / STP tabs (`data-testid="payroll-pay-date-footer"`) and one on the AU BAS return when W1/W2 show (`data-testid="return-wages-basis"`), styled like the existing `return-sales-basis` note (`text-xs text-muted-foreground`).
- [x] Both strings go through `useT` / `useI18n`; keys exist in en, fr-CA and zh-CN (`core_ui.payroll_reports_use_pay_date`, `tax_ui.return_wages_by_pay_date`); fr-CA uses U+2019 (`payroll-page-paydate-footer.test.tsx`), and the BAS footer renders translated in all three locales (`sales-tax-return-lines.test.tsx`).
- [x] Statutory filing text (the "prepared, not lodged" disclosures) is unchanged and stays English, per the existing pattern.
- [x] The footer says what the numbers mean in the user's terms: reports use the pay date, profit and loss uses the period end.
- [x] The AU tax plugin UMD bundle was rebuilt and committed to `public/cdn`.
