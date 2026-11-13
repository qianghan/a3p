# PR 1 — visual review on the deployed build

Tick only after looking at the real page in a browser (screenshots go in the PR comment).

## Desktop `/agentbook/expenses/new` (1280×900)
- [ ] English, light theme: the Category field and hint sit inside the form like the other fields.
- [ ] English, dark theme: border, text and hint have the same contrast as their siblings.
- [ ] fr-CA (Maya): label "Catégorie", placeholder and hint text fit without wrapping badly.
- [ ] zh-CN: label, placeholder and hint render in Chinese, no English fallback.
- [ ] Typing a known vendor prefills the category with the hint; changing it removes the hint.

## Mobile `/app/capture` (390×844)
- [ ] Manual entry: typing a known vendor selects the suggested chip with the "AI guess" pill.
- [ ] Light and dark themes: the selected chip is clearly distinguishable.
- [ ] Choosing another chip afterwards is not overridden when the vendor text changes.
