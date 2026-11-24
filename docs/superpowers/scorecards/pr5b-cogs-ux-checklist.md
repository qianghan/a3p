# PR 5B — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr5b-cogs-ux-postdeploy.md`.

- [x] The item picker sits inside the existing New Invoice line row (below the description), same field styling; it appears only when `trackInventory` is on, so freelancers see no change (`new-invoice-item-picker.test.tsx`).
- [x] Picking an item fills an empty description and an empty rate from the item's sale price; the user can still edit both.
- [x] COGS by quarter and the Write off dialog live on the existing Expenses › Items page; no new sidebar destination.
- [x] Write off asks for a positive quantity and a required reason, and says it books to Inventory Shrinkage at average cost; it posts the existing adjust route (negative qty).
- [x] Every new string goes through `useI18n` / the skill reply catalog with keys in en, fr-CA and zh-CN (`invoice_ui.inventory_item|no_inventory_item|in_stock_count`, `expenses_ui.items_write_off|items_writeoff_help|items_quantity_to_write_off|items_writeoff_invalid|items_cogs_by_quarter|items_cogs_empty|items_period|items_cost_of_goods_sold|items_total`, `skill.cogs_*`); fr-CA uses U+2019; key names read as UI text.
- [x] Money renders through the shell's locale-bound `formatCurrency`; COGS amounts are computed on the server, never in the UI.
- [x] Chat "what's my COGS this quarter?" (en/fr-CA/zh-CN) reaches `query-cogs` through the real triage, not the advisor; the reply states the period dates.
- [x] Both UMD bundles (agentbook-invoice, agentbook-expense) rebuilt and committed to `public/cdn`.
