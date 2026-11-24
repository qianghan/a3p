# PR 5B — UX post-deploy browser pass

To tick in a real browser on the deployed site (en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney); trackInventory is already ON for alex/maya/sydney.

- [ ] New Invoice: the "Inventory item" picker shows under each line's description with stock counts, translated in en, fr-CA (maya, U+2019 renders) and zh-CN; picking an item fills description + price.
- [ ] Create a tagged invoice with an item line: the item's on-hand drops on Expenses › Items; void it and the stock returns (then delete the tagged fixtures).
- [ ] Expenses › Items: "Cost of goods sold by quarter" section renders translated; empty state reads as a sentence, not a humanised key.
- [ ] Items › Write off: quantity + required reason; saving lowers stock and value; the reason is required (localized error).
- [ ] Chat (maya, French): "Quel est mon coût des marchandises vendues ce trimestre ?" answers in French with the period dates (not the advisor).
- [ ] Chat (alex): "What's my COGS this quarter?" answers with the amount and the period.
- [ ] No humanised key anywhere on these surfaces.
