# PR 2b — UX review on the deployed site (controller, real browser)

- [ ] sydney (AU) mobile Capture tax row, light mode: GST chip preselected, "Tax $10.00 · total $110.00" on $110, toggle reads well at 390 px.
- [ ] sydney (AU) mobile Capture tax row, dark mode: chip, toggle and muted text contrast.
- [ ] maya (fr-CA) mobile Capture: tax row strings in French, province default code, no clipped labels.
- [ ] maya (fr-CA) Business Profile: GST/HST and QST registration and the GST reporting basis controls in French.
- [ ] zh-CN (switch a persona's locale for the check, then restore): capture tax row and Business Profile strings.
- [ ] alex (US) mobile Capture: no tax row at all.
- [ ] Desktop New Expense tax row at 1280 px (sydney and maya): layout aligned with the other fields, preview total matches.
- [ ] BAS view (sydney): G10/G11 rows present and labelled; 1B matches the API.
- [ ] CA GST/HST return (maya): the QST ITR line renders (0 when not QST-registered) with correct formatting.
