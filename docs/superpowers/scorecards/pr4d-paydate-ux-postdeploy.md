# PR 4d — UX post-deploy browser pass

To tick in a real browser on the deployed site (per locale: en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney).

- [x] Payroll → STP tab (sydney): pay-date footer visible under the pay event, en.
- [x] Payroll → Year-end tab: footer visible in en (alex), fr-CA (maya, U+2019 apostrophe renders) and zh-CN.
- [x] Payroll → Tax deposits tab: footer visible in en, fr-CA and zh-CN.
- [x] Tax → Sales tax return (sydney, a quarter with wages): the W1/W2 pay-date note shows under the lines in en, fr-CA and zh-CN; absent in a quarter with no wages. — prod 2026-11-19: verified ABSENT in en + zh-CN for sydney's current quarter (no wages); the PRESENT case needs a processed pay run (irreversible on prod) and is covered by the SalesTaxReturn component test.
- [x] Footer text is not a humanised key (no "Payroll reports use pay date").
