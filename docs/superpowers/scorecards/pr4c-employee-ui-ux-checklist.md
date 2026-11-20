# PR 4c — UX consistency review (before merge)

- [x] Every new user-visible string goes through `useT()`; keys exist in en / fr-CA / zh-CN (U+2019 apostrophes in fr-CA).
- [x] Key names read as UI text (e.g. `core_ui.fortnightly`, `core_ui.back_to_payroll`), no `a11y_*`-style names.
- [x] Frequency label map: AU biweekly = Fortnightly, US/CA = Bi-weekly, in core_ui and the chat reply catalog (agent).
- [x] Profile sections follow the market: AU TFN/residency/super; CA SIN/TD1/CPP-EI; US SSN/W-4.
- [x] Sensitive inputs never pre-filled; masked last4 shown as placeholder and "On file, ending ####".
- [x] 503 pii_key_unconfigured shows an amber status banner and disables encrypted inputs; other edits still save.
- [x] Reveal only on explicit click; value held in component state only; Hide / 30 s re-mask.
- [x] Every input has a `<label for>`; banners use role=status / role=alert.
- [x] Colours use theme tokens (border-border, bg-card, text-muted-foreground, amber banner as in the AU STP notice), so dark mode follows.
- [x] Dates in the pay-run list render the UTC calendar date (no off-by-one in western time zones).
