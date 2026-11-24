# PR 3d — UX post-deploy browser pass

To tick in a real browser on the deployed site (en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney). Use tagged fixtures and void them afterwards.

Run 2026-11-23 on agentbook.brainliber.com (deploys of f023c1aa, then fixes #661 b903a063, #662 7d1d3f7f, #664 c6a6cee3) with `tests/e2e/mobile-app/bills-ui.spec.ts` (9/9 passed for alex, maya, sydney) plus a scripted Playwright pass per persona (tagged bills created and voided; screenshots kept with the session evidence). purchases_at_entry is still OFF for every tenant (owner to enable), so all new bills are at_payment: part payments and amendments are not offered, by design (#661). zh-CN not exercised on screen; catalog guards cover it.

- [x] Expenses › Bills: filter tabs, aging cards and the Still owing column render translated in en, fr-CA (maya, U+2019 renders) and zh-CN; no humanised key. — fr "Factures à payer / À payer / Ancienneté / Solde dû"; money was en-formatted on the French page → fixed in #664 (locale-bound, "12 756,00 $").
- [x] Add a tagged bill; Pay part half; the row reads Partly paid with the other half owing; Pay the rest → Paid. — e2e adds and pays on all three personas; Pay part is (correctly) absent on at_payment bills — the e2e runs the part path only for at_entry bills. Found and fixed: Pay part was offered on at_payment bills and always failed (#661).
- [x] Expand the bill: payments listed; Void payment → Open again; Void → Void (AP card back to its prior value). — e2e voids payments and the bill through the UI; 2000/1000 back to baseline and the trial balance balanced on all three.
- [x] Edit an unpaid posted bill's amount → the AP card moves by the difference. — at_entry only; not reachable while the flag is off. Legacy at_payment edit (PUT) is covered by bills-page.test.tsx.
- [x] /app/capture: Pay later → bill saved, appears on Bills, not as a paid expense. — e2e "mobile Capture Pay later creates a bill, not an expense" 3/3. Airplane-mode queue replay covered by the api client idempotency test (not exercised on prod).
- [x] /app Home: two tagged bills due → one alert "2 bills due — … still owing". — sydney "2 bills due — A$30 still owing"; alex/maya listed per-bill rows with the tagged vendors.
- [x] Chat (alex): record → "What bills are due?" → "Pay the <tag> bill" → paid in full. — e2e 3/3. Found and fixed: vendor names lost their digits (#661); "Pay the <tag> bill" asked which bill because of first-word prefix matches (#662).
- [x] Chat (maya, French): "Quelles factures à payer sont en retard ?" answers from the books in French. — routed to query-payables but replied in English after earlier English turns → language detector fixed in #664.
- [x] Bank review: candidate list offers "Bill: <vendor>"; one tap pays the bill and no expense row appears. — no tagged bank debit can be created on prod (Plaid sandbox only); covered by bank-bill-match.test.ts (27 cases incl. the claim race).
