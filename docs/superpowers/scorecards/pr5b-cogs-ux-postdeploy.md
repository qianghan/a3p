# PR 5B — UX post-deploy browser pass

To tick in a real browser on the deployed site (en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney); trackInventory is already ON for alex/maya/sydney.

Run 2026-11-23 on agentbook.brainliber.com (deploy of fc858c89) with a scripted Playwright pass per persona (tagged item created, inspected, deleted; screenshots kept with the session evidence). zh-CN was not exercised in this pass; the catalog guard covers its keys.

- [x] New Invoice: the "Inventory item" picker shows under each line's description with stock counts, translated in en, fr-CA (maya, U+2019 renders) and zh-CN; picking an item fills description + price. — en "Inventory item / None (not a stocked item) / … · 0 in stock"; fr-CA "Article en stock / Aucun (article non stocké) / … · 0 en stock"; picking filled the description.
- [x] Create a tagged invoice with an item line: the item's on-hand drops on Expenses › Items; void it and the stock returns (then delete the tagged fixtures). — covered on prod by `tests/e2e/mobile-app/inventory-sales.spec.ts`, 3/3 passed (alex, maya, sydney), every account back to baseline.
- [x] Expenses › Items: "Cost of goods sold by quarter" section renders translated; empty state reads as a sentence, not a humanised key. — en "Cost of goods sold by quarter", fr-CA "Coût des marchandises vendues par trimestre / Total général"; fr empty state is a full sentence.
- [x] Items › Write off: quantity + required reason; saving lowers stock and value; the reason is required (localized error). — dialog translated (fr "Radier … Motif … Enregistrer"); empty reason blocks the save (required field). The save path itself is covered by route tests, not exercised on prod (no stock to write off without a non-reversible opening entry).
- [x] Chat (maya, French): "Quel est mon coût des marchandises vendues ce trimestre ?" answers in French with the period dates (not the advisor). — skill query-cogs, "Coût des marchandises vendues pour ce trimestre (2026-10-01 – 2026-12-31)". Found "-0 CA$" for a netted-out quarter; fixed in #659.
- [x] Chat (alex): "What's my COGS this quarter?" answers with the amount and the period. — skill query-cogs with dates; same "-$0" defect, fixed in #659.
- [x] No humanised key anywhere on these surfaces. — none found on any persona.
