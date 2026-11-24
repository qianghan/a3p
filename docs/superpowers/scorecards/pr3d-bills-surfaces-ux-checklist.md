# PR 3d — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr3d-bills-surfaces-ux-postdeploy.md`.

- [x] Bills stays the existing Expenses › Bills tab (no new sidebar destination); filters are a `role="tablist"` (All / Open / Overdue / Paid) with translated labels instead of the raw English status words the old tab row rendered.
- [x] Aging buckets reuse the report's four buckets and labels match the chat reply's (not yet due · 1–30 · 31–60 · 60+ days overdue); amounts come from `reports/ap-aging`, never computed in the UI.
- [x] Each row shows Amount and Still owing; a partly paid bill reads "Partly paid"; status pills keep the existing colour scheme (partial adds blue).
- [x] Add / Edit share one form with visible `<label>`s on every field; money fields are `inputMode="decimal"` text inputs parsed by the shell's locale-aware `parseAmount` (a fr-CA user can type `84,50`); edit prefills with the locale number format.
- [x] Pay, Pay part, Edit, Void and Void payment are real buttons with accessible names; the row's vendor toggles the payments panel with `aria-expanded`; errors render in `role="alert"`; the actions header has an sr-only label.
- [x] Every confirm prompt and error is a catalog string (`expenses_ui.bill_*`, `aging_*`) in en, fr-CA (U+2019) and zh-CN; server messages are never shown raw (`payErrorKey` / `writeErrorKey` map codes).
- [x] Mobile Capture: "Pay later" is a `role="switch"` with a described hint, shown only for manual business entries; the due date appears only when on; queued / saved toasts reuse the Capture tone rules; new keys under `mobile.capture.*`.
- [x] Home: several due bills collapse into one alert ("3 bills due — $1,240 still owing") instead of hiding all but the first; overdue variant keeps critical severity.
- [x] Chat replies (`skill.bill_*`, `skill.payables_aging`, `skill.bills_overdue_suffix`) in three locales; the old hardcoded "(N overdue)" English suffix is now catalogued.
- [x] Telegram bank-match replies (`bot.bill_paid_from_bank`, `bot.bill_part_paid_from_bank`, `bot.bill_label`) in three locales.
- [x] UMD bundle (agentbook-expense) rebuilt and committed to both `public/cdn` paths, with the rebuilt CSS.
