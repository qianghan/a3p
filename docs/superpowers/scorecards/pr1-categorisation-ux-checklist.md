# PR 1 — UX consistency review (before merge)

Each box is ticked only after comparing the new element with a named sibling in the product. Evidence in italics.

## Desktop — `NewExpense.tsx` (sibling: the Vendor / Description / Date fields of the same form)
- [x] The Category control uses the same field styling as its siblings (`w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50`). *Identical class string to the Vendor input.*
- [x] Its label follows the same label style as the sibling labels (`block text-sm font-medium mb-1`). *Same string.*
- [x] The "where did this come from" hint reuses the form's existing hint style (`text-xs text-muted-foreground`), as the receipt `prefilled_hint` does.
- [x] Every label is now associated with its control (`htmlFor`/`id`), so screen readers and tests find fields by name. *The existing Amount/Vendor/Description/Date labels were not; fixed in the same change.*
- [x] The field order reads top to bottom as the user thinks: amount, vendor, description, category, date, personal. *Category sits after the vendor that drives it.*
- [x] Business-expense Category is required; a personal expense is not and sends no category. *new-expense-category.test.tsx.*

## Mobile — `capture/page.tsx` (sibling: the photo path's OCR category guess on the same screen)
- [x] A suggested category is shown with the same chip row and the same "AI guess" pill the photo path already uses; no new component or colour. *Same `Chip` + `Pill tone="primary"`.*
- [x] A category the person picked is never replaced by a late suggestion, exactly as on the desktop form. *capture-page.test.tsx and new-expense-category.test.tsx assert the same rule.*
- [x] No layout shift: the suggestion fills an existing chip row; nothing is inserted above the fields. *No new in-flow element.*
- [x] Touch targets unchanged (chips are the existing 44 px kit chip).

## Copy and locales
- [x] New strings exist in en, fr-CA (typographic apostrophes) and zh-CN, with `{pct}` placeholders intact. *i18n guards in U1; per-locale render tests in new-expense-category.test.tsx.*
- [x] Key names read as UI text, none are brand names. *`expenses_ui.category_*`.*
- [x] Confidence is shown only for learned/AI suggestions, not for "remembered from your past expenses", which is a fact rather than a guess.
