# PR 3d — UX post-deploy browser pass

To tick in a real browser on the deployed site (en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney). Use tagged fixtures and void them afterwards.

- [ ] Expenses › Bills: filter tabs, aging cards and the Still owing column render translated in en, fr-CA (maya, U+2019 renders) and zh-CN; no humanised key.
- [ ] Add a tagged bill; Pay part half (fr-CA: type `12,50`); the row reads Partly paid with the other half owing; Pay the rest → Paid.
- [ ] Expand the bill: both payments listed; Void payment twice → Open again; Void → Void (the AP card returns to its prior value).
- [ ] Edit an unpaid posted bill's amount → the AP card moves by the difference.
- [ ] /app/capture (phone width): Enter without a photo → Pay later switch → due date → Save → "Bill saved"; it appears on the Bills page, not in Docs as a paid expense. Repeat once in airplane mode → Queued pill → reconnect → exactly one bill.
- [ ] /app Home: with two tagged bills due within the window, one alert "2 bills due — … still owing".
- [ ] Chat (alex): "Add a bill from <tag> $43.21 due <date>" → recorded; "What bills are due?" → list + aging line; "Pay the <tag> bill" → paid in full.
- [ ] Chat (maya, French): "Quelles factures à payer sont en retard ?" answers from the books in French (not the advisor).
- [ ] Bank review (if a tagged debit is available): the candidate list offers "Bill: <vendor>"; one tap pays the bill and no expense row appears.
