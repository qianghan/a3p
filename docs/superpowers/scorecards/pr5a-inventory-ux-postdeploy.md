# PR 5A — UX post-deploy browser pass

To tick in a real browser on the deployed site (en = alex, fr-CA = maya, zh-CN = switch locale; AU = sydney), after `npx tsx agentbook/seed-persona-inventory.ts --apply`.

- [ ] Settings › Business Profile: "Track inventory" checkbox visible and saved (alex), in en, fr-CA (U+2019 renders) and zh-CN.
- [ ] Expenses › Items tab: renders translated in en, fr-CA (maya) and zh-CN; with tracking off, the turn-on message (not a humanised key).
- [ ] Items: create an item, add opening stock, adjust −1; stock value and average cost update; delete removes the row.
- [ ] Items: duplicate SKU shows the localized message.
- [ ] Mobile Home (sydney, an item at/below its reorder point): low-stock alert shows, tapping it opens chat with the prefilled question.
- [ ] Chat (maya, French): "what's low on stock?" answers in French with the items and values.
- [ ] No humanised key anywhere on these surfaces (no "Items turn on tracking").
