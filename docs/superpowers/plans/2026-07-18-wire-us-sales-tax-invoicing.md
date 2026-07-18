# Wire US Sales Tax Into Invoicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make US invoices apply real per-state sales tax (using the already-implemented, already-correct `usSalesTax` engine) instead of the current hardcoded `ZERO_TAX` result, exactly mirroring the pattern already proven for AU GST and CA GST/HST/PST (Launch-gap PR-6).

**Architecture:** Extend `computeInvoiceTax` (`apps/web-next/src/lib/agentbook-invoice-tax.ts`) with a third jurisdiction branch (`us`, alongside the existing `au`/`ca` branches), calling the already-implemented `usSalesTax.calculateTax(subtotalCents, region)` from `@agentbook/jurisdictions/us/sales-tax`. Extend `NewInvoice.tsx`'s client-side rate-preview logic and `showTaxField` gate the same way its existing `au`/`ca` branches already work. No new files, no new abstraction — this is adding one more branch to an already-generalized function and an already-generalized UI condition.

**Tech Stack:** Next.js API routes, Vitest.

## Global Constraints

- No new abstraction layers — reuse `computeInvoiceTax`'s existing branch structure exactly.
- `region` for a US tenant is a free-text 2-letter state code already collected via Business Profile's existing "State / Province / Territory" field (`AgentBookSettingsPanel.tsx:1680`) — no new UI field needed for state entry.
- A US tenant with no `region` set (empty string) must get an explicit `$0` result (not an error) — `usSalesTax.calculateTax` already returns rate `0` for an unrecognized/empty region key, matching the roadmap's "non-nexus states / no rate configured falls back to $0 explicitly, not silently" acceptance criterion.
- Regular AU/CA invoice-tax behavior must be provably unchanged — this is a pure addition of a third branch, not a restructure of the existing two.

---

### Task 1: Add the `us` branch to `computeInvoiceTax`

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-invoice-tax.ts`
- Test: `apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts` (existing file — read it first to match its established test structure/fixtures for the `au`/`ca` branches before adding `us` cases)

**Interfaces:**
- Consumes: `usSalesTax` from `@agentbook/jurisdictions/us/sales-tax` (already exists, already exports `calculateTax(amountCents, region): SalesTaxResult` with `{ totalRate, totalCents, components: [{ type: 'state', rate, amountCents }] }` shape when `rate > 0`, or `{ totalRate: 0, totalCents: 0, components: [] }` when the region has no configured rate).
- Produces: `computeInvoiceTax` now returns a real, non-zero `InvoiceTaxResult` for `jurisdiction === 'us'` tenants with a recognized-and-nonzero-rate `region`; unchanged `ZERO_TAX` for unrecognized/empty `region` or any other jurisdiction.

- [ ] **Step 1: Read the existing test file in full** to learn its exact mocking pattern for `db.abTenantConfig.findUnique` and the assertion style used for the `au`/`ca` branches — write new `us` cases in the same style, not a new pattern.

- [ ] **Step 2: Write failing tests** covering: (a) a US tenant with `region: 'CA'` (California, 7.25% per the existing `STATE_RATES` table) gets a non-zero tax result with one `'state'`-type component crediting a liability account code; (b) a US tenant with `region: 'OR'` (Oregon, 0% — a real no-sales-tax state already in `STATE_RATES`) gets `ZERO_TAX`-shaped output (rate 0, cents 0, empty components); (c) a US tenant with no `region` set (`''`) gets `ZERO_TAX`-shaped output; (d) an `overrideRate` supplied for a US tenant with a recognized state applies via the existing `scaleComponentsToOverride` helper, matching how the `au`/`ca` branches already handle overrides.

- [ ] **Step 2: Run tests, confirm they fail** (no `us` branch exists yet — falls through to the final `// US/UK/other` catch-all).

- [ ] **Step 3: Implement the branch**

Add the import and a new branch, following the exact shape of the existing `ca` branch (which also does a single-component-type lookup by region):

```ts
import { usSalesTax } from '@agentbook/jurisdictions/us/sales-tax';

// ... inside computeInvoiceTax, after the `ca` branch and before the final comment/return:

  if (jurisdiction === 'us') {
    const region = tenantConfig?.region || '';
    const result = usSalesTax.calculateTax(subtotalCents, region);
    if (overrideRate != null) {
      const components = scaleComponentsToOverride(result.components, result.totalRate, overrideRate, subtotalCents, () => '2100');
      return { taxRate: overrideRate, taxCents: components.reduce((s, c) => s + c.amountCents, 0), components };
    }
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: toInvoiceComponents(result.components, () => '2100'),
    };
  }

  // UK/other — out of scope for this plan; unchanged zero-tax behavior.
  return ZERO_TAX;
```

Update the file's top comment (currently "Scope is AU and CA only") and the final fallback comment (currently "US/UK/other — out of scope") to reflect that US is now in scope and only UK/other remain out of scope. `'2100'` matches the account code convention already used for AU's single-component GST (a state sales-tax liability is a single line, unlike CA's GST-vs-PST split, so `caAccountCodeFor`'s two-way branch isn't needed here — a plain `() => '2100'` constant function is correct and consistent with the AU branch's own `() => '2100'`).

- [ ] **Step 4: Run tests, confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/agentbook-invoice-tax.ts apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts
git commit -m "feat(invoice): wire US per-state sales tax into computeInvoiceTax"
```

---

### Task 2: Show the tax field for US invoices in the frontend

**Files:**
- Modify: `plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 directly (this is a client-side preview only — the actual persisted tax comes from Task 1's backend change via the existing `computeInvoiceTax` call in the invoice-creation route, which this task does not touch).
- Produces: nothing consumed by a later task — this plan has only 2 tasks.

- [ ] **Step 1: Add a `US_STATE_RATES` table mirroring `packages/agentbook-jurisdictions/src/us/sales-tax.ts`'s `STATE_RATES`, and extend `defaultTaxRatePercent`**

```tsx
// Mirrors packages/agentbook-jurisdictions/src/us/sales-tax.ts's STATE_RATES —
// see that file's authoritative table if these ever need updating.
const US_STATE_RATES: Record<string, number> = {
  CA: 7.25, NY: 4, TX: 6.25, FL: 6, WA: 6.5,
  IL: 6.25, PA: 6, OH: 5.75, GA: 4, NC: 4.75,
  OR: 0, NH: 0, MT: 0, DE: 0, AK: 0,
};

function defaultTaxRatePercent(jurisdiction: string, region: string): number {
  if (jurisdiction === 'au') return 10;
  if (jurisdiction === 'ca') return CA_PROVINCE_RATES[region.toUpperCase()] ?? 0;
  if (jurisdiction === 'us') return US_STATE_RATES[region.toUpperCase()] ?? 0;
  return 0;
}
```

Note: `packages/agentbook-jurisdictions/src/us/sales-tax.ts`'s `STATE_RATES` values are fractions (e.g. `0.0725`); this file's convention (matching the existing `CA_PROVINCE_RATES` table just above it) is percentages (e.g. `7.25`) — the table above already converts, matching the existing pattern exactly (compare `CA_PROVINCE_RATES.QC: 14.975` here vs. the CA package's `0.14975`).

- [ ] **Step 2: Extend `showTaxField`**

```tsx
  const showTaxField = jurisdiction === 'au' || jurisdiction === 'ca' || jurisdiction === 'us';
```

- [ ] **Step 3: Update the code comment above `showTaxField`** (currently "AU/CA only, per computeInvoiceTax's scope") to include US.

- [ ] **Step 4: Manual verification** — since this is a frontend-only preview change with no existing test harness for this specific component (confirm by checking for a `NewInvoice.test.tsx` — if one exists, add a case there instead of skipping; if not, this step is a static read-through, not a skipped requirement): confirm the tax-rate input renders and pre-fills correctly for `jurisdiction: 'us', region: 'CA'` (should show `7.25`) and for `region: 'OR'` or an empty region (should show `0`, field still visible per the roadmap's "US invoices never collect sales tax" fix intent — visible-and-zero is correct, hidden-and-zero was the bug).

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx
git commit -m "feat(invoice): show the tax-rate field for US invoices"
```

## Self-Review

- Spec coverage: both halves of the roadmap's PR US-1 entry (backend dead-code fix, frontend hidden-field fix) are covered.
- Placeholder scan: none.
- Consistency: `US_STATE_RATES` values cross-checked against the backend's `STATE_RATES` (same states, percentage-converted).
