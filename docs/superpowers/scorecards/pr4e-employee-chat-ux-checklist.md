# PR 4e — UX consistency review (before merge)

Ticked from code and the unit/guard tests named in the manifest; the live pass is in `pr4e-employee-chat-ux-postdeploy.md`.

- [x] No new screen: chat replies only. Every new string is a `agent.*` reply-catalog key present in en, fr-CA and zh-CN (`i18n-catalog.test.ts`); labels per locale asserted in `employee-chat-skills.test.ts`.
- [x] Frequency labels reuse the existing `agent.fortnightly` / `agent.bi_weekly` keys; the chat map is pinned to the web map (`employee-chat-label-parity.test.ts`).
- [x] Money uses the tenant currency in the reply locale (`tenantMoney`), salary "/yr", hourly "/hr".
- [x] Edits show the standard plan card with a localized line naming the new frequency before anything is written.
- [x] Refusals point to the employee profile screen and never echo the typed value.
