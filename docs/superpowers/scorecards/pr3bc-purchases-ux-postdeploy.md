# PR 3bc — UX post-deploy browser pass

Run on the deployed site after merge, with `purchases_at_entry` enabled for the persona under test. Tick only from a real browser.

- [ ] Desktop Bills page: pay a tagged bill for more than it owes → the overpayment message shows; pay in a closed period → the period-closed message shows (alex, maya, sydney).
- [ ] Desktop Reports: with an open at_entry bill, the Cash basis option is disabled and the banner explains why; it clears after the bill is paid or voided.
- [ ] Settings: the accounting-basis note about open bills shows while one exists.
- [ ] BAS (sydney) and the CA GST/HST return (maya): the footnote names the basis bills were counted on, matching Business Profile.
- [ ] Mobile `/app/docs`: a tagged bill row shows Due, then Paid after paying; tapping opens the bill sheet with total, outstanding and due date — in light and in dark mode.
- [ ] fr-CA (maya): bill rows, badge, sheet, Reports banner and Settings note render in French (no English fallbacks, U+2019 apostrophes).
- [ ] zh-CN: the same surfaces render in Simplified Chinese.
