# PR 2c — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the browser pass is in `pr2c-restatement-ux-postdeploy.md`.

- [x] The restatement card lives in the existing Settings › Business Profile, directly under the GST/HST registration and reporting-basis controls it depends on; it renders only for AU/CA tenants with GST/HST registration = Yes. No new sidebar destination.
- [x] Preview first: the card loads the server preview for the selected tax year (AU shows the 1 Jul – 30 Jun year as "2025–2026") and states the count, the recoverable tax, the P&L effect and each row; closed-month, needs-a-check and already-typed counts are shown as plain sentences.
- [x] Apply is a two-step action: the first click opens a confirmation that states the count and the amount moving to the GST/HST account; Cancel closes it with nothing sent (`tax-restatement-card.test.tsx` asserts no POST before "Yes, restate").
- [x] After apply the card shows the result and reloads the preview, which then reads "Nothing to restate for this tax year."
- [x] The BAS / GST-HST return and the P&L carry a one-line note while the current tax year still has eligible legacy rows, pointing at Settings › Business Profile; it disappears once applied and never appears for US or non-registrants (`restatement-note.test.tsx`).
- [x] Every new string goes through `useT` / `useI18n` / the skill and agent reply catalogs with keys in en, fr-CA and zh-CN (`core_ui.restate_*`, `tax_ui.restatement_note_*`, `skill.restatement_*`, `agent.restatement_confirm`); fr-CA uses U+2019; key names read as UI text; catalog/French/plugin-context guards green.
- [x] Money renders through the locale-bound formatters (`formatCurrencyCents` in the shell, `tenantMoneyCompact` in chat); every figure is computed on the server.
- [x] Chat: "preview the tax restatement for 2026" / "Retraiter ma TPS pour 2026" / "重述 2026 年的 GST" reach restatement-preview / restatement-apply through the real triage (not the advisor); apply shows a plan naming the tax year and runs only after "yes".
- [x] The agentbook-tax UMD bundle (Reports, SalesTaxReturn) is rebuilt and committed to `public/cdn`; the Settings card is shell code (no bundle).
