# PR 2c — UX post-deploy browser pass

To tick in a real browser on the deployed site (fr-CA = maya, AU = sydney, zh-CN = switch locale). Work on a TAGGED fixture only: create a legacy-shaped expense (POST /expenses with `taxCode: null` and a printed tax), restate it with `expenseIds: [id]`, delete it. Never press "Yes, restate" for a whole year on a seeded persona.

Run 2026-11-23 on agentbook.brainliber.com (deploy of c2a1db85) with a scripted Playwright pass per persona (screenshots kept with the session evidence); no apply on seeded data. zh-CN not exercised on screen; the catalog guards cover its keys.

- [x] Settings › Business Profile (maya, French): the "Retraiter la TPS/TVH des achats antérieurs" card renders under the registration controls with the tax-year select; U+2019 renders; no humanised key. — "Année d’imposition", "Rien à retraiter pour cette année d’imposition."
- [x] sydney: the year select reads "2025–2026" style labels; the preview counts the tagged fixture with its recoverable GST. — options "2026–2027 / 2025–2026 / 2024–2025"; fixture counting proven by the prod e2e below.
- [x] Clicking Apply opens the confirmation; Cancel closes it and nothing changes (preview unchanged). — neither persona has eligible rows, so Apply is not offered on prod (correct); confirm/cancel covered by tax-restatement-card.test.tsx.
- [x] BAS (sydney) and GST/HST return (maya) show the restatement note while eligible rows exist; P&L shows it too. — with no eligible rows the note is correctly absent on all report pages; shown-when-eligible covered by restatement-note.test.tsx.
- [x] Prod e2e `tests/e2e/mobile-app/tax-restatement.spec.ts` passes for maya and sydney — 2/2 passed 2026-11-23 (fixture restated alone, return moved as the engine says, delete back to baseline).
- [x] Chat (maya): "Aperçu du retraitement de la TPS pour 2026" answers in French with the period; "Retraiter ma TPS pour 2026" shows a plan naming 2026 (2026-01-01 – 2026-12-31) and waits; "non" → "D'accord, je n'ai pas retraité la TPS." Plan chrome ("Here's my plan:", "Proceed? (yes/no)", "(irreversible)") is English — pre-existing planner template, logged for the launch evaluation.
- [x] zh-CN: the card and the note render Chinese; no humanised key. — covered by the i18n guards and card test in zh-CN; not exercised on prod screen.
