# PR 5A — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr5a-inventory-ux-postdeploy.md`.

- [x] New Items tab sits in the existing Expenses tab bar (Expenses · Bills · Items), same `ExpenseTabs` component and `/agentbook/expenses/*` registration as Bills; no new sidebar destination.
- [x] Every string goes through `useI18n` / `useT` / the agent reply catalog; keys exist in en, fr-CA and zh-CN (`expenses_ui.items_*`, `core_ui.track_inventory*`, `common.persona_merchant`/`persona_retail`, `skill.stock_*`, `mobile.home.alert.low_stock*`, `mobile.chat.topic_low_stock`, `tabs.items`); fr-CA uses U+2019; key names read as UI text (no `a11y_*`-style names).
- [x] With tracking off the Items page says where to turn it on (Settings › Business Profile) instead of an empty table; chat says the same (`items-page.test.tsx`, `query-stock-skill.test.ts`).
- [x] Errors are the server's reason, localized: duplicate SKU (409), closed period (422), generic failure.
- [x] Money renders through `formatMoney` in the tenant currency; quantities show with their unit; average cost is derived on the server, never recomputed in the UI.
- [x] Business Profile toggle: a labelled checkbox with help text, offered only to the merchant/retail business types (new persona options) or a tenant already enabled; gated on the flag (`inventory-toggle.test.tsx`, mutation-checked).
- [x] Mobile Home `low_stock` alert routes to `/app/chat?topic=low_stock` (a mobile route, never a desktop page) with a prefilled, unsent question.
- [x] The agentbook-expense UMD bundle (+ css, manifest) was rebuilt and committed to `public/cdn`.
