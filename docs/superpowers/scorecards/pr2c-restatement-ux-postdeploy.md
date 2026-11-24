# PR 2c — UX post-deploy browser pass

To tick in a real browser on the deployed site (fr-CA = maya, AU = sydney, zh-CN = switch locale). Work on a TAGGED fixture only: create a legacy-shaped expense (POST /expenses with `taxCode: null` and a printed tax), restate it with `expenseIds: [id]`, delete it. Never press "Yes, restate" for a whole year on a seeded persona.

- [ ] Settings › Business Profile (maya, French): the "Retraiter la TPS/TVH des achats antérieurs" card renders under the registration controls with the tax-year select; U+2019 renders; no humanised key.
- [ ] sydney: the year select reads "2025–2026" style labels; the preview counts the tagged fixture with its recoverable GST.
- [ ] Clicking Apply opens the confirmation; Cancel closes it and nothing changes (preview unchanged).
- [ ] BAS (sydney) and GST/HST return (maya) show the restatement note while eligible rows exist; P&L (Tax › Reports › Profit & Loss) shows it too.
- [ ] Prod e2e `tests/e2e/mobile-app/tax-restatement.spec.ts` passes for maya and sydney (fixture restated alone, P&L −recoverable, 2100 +recoverable, second apply no-op, delete back to baseline).
- [ ] Chat (maya): "Aperçu du retraitement de la TPS pour 2026" answers in French with the count and amount; "Retraiter ma TPS pour 2026" shows a plan naming 2026 and waits — answer "non" (do not apply to seeded data).
- [ ] zh-CN: the card and the note render Chinese; no humanised key.
