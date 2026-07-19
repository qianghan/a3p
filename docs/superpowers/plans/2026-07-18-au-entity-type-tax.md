# AU taxEntityType-Aware Tax Calculation (Roadmap PR AU-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AU tenant who has selected `taxEntityType = 'pty_ltd'` (Tax Dashboard's "Business Type"/entity-type selector, already wired to `AbTenantConfig.taxEntityType` by a prior PR) gets a flat 25% corporate tax estimate instead of individual progressive-bracket + Medicare Levy math. Every other entity type (`sole_trader`, `trust`, unset/null) and every non-AU jurisdiction is completely unaffected.

**Architecture:** `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` already reads `tenantConfig` and computes tax via `BRACKET_PROVIDERS[jurisdiction]`/`SE_TAX_CALCULATORS[jurisdiction]` (real jurisdiction-pack providers from `@agentbook/jurisdictions`) but never reads `tenantConfig.taxEntityType` at all — every AU tenant, regardless of entity type, gets the individual `auTaxBrackets` + `auSelfEmploymentTax` (Medicare Levy) path. This PR adds a new jurisdiction-pack provider, `auCompanyTaxBrackets` (a flat 25% "base rate entity" ATO company tax rate, modeled the same way as every other bracket provider — a `TaxBracketProvider` with a single all-income bracket, so it slots into the exact same `calculateTax()` call shape everything else already uses), and adds one conditional in the route: when `jurisdiction === 'au' && taxEntityType === 'pty_ltd'`, use `auCompanyTaxBrackets` instead of `auTaxBrackets`, and skip the Medicare Levy self-employment-tax calculation entirely (companies don't pay individual Medicare Levy on retained business profit — that only applies to wages/distributions drawn by the individual, which isn't modeled here). Every other combination is byte-identical to today.

**Tech Stack:** TypeScript, Next.js API routes, Vitest.

## Global Constraints

- **Reuse before rewrite / minimal new surface:** the new company-tax provider reuses the exact same `TaxBracket`/`TaxCalculation`/`TaxBracketProvider` interfaces every other jurisdiction-pack file already implements (`packages/agentbook-jurisdictions/src/interfaces.ts`) — a flat rate is modeled as a bracket table with one row (`{ min: 0, max: null, rate: 0.25 }`), not a new interface or new calculation shape.
- **Scope is AU only.** Do not add US/CA entity-type branching (LLC/S-corp/C-corp taxation) — those are structurally different tax regimes and explicitly out of scope for this PR. Do not modify `cashflow/scenario/route.ts` (fixed in a separate, already-merged PR) — the roadmap scopes this fix to "the tax-estimate calculation" only.
- **`trust` is deliberately NOT given company-tax treatment.** Real AU trust taxation (income flows through to beneficiaries via distribution resolutions, or is taxed to the trustee at the top marginal rate if undistributed) isn't modelable with the data this app collects. `trust` keeps the existing individual-progressive-bracket + Medicare-Levy path (same as `sole_trader` and unset), which is an honest, conservative default — do not fabricate trust-specific math.
- **No schema migration.** `AbTenantConfig.taxEntityType` already exists (nullable `String`).

---

### Task 1: Add the AU flat company-tax provider

**Files:**
- Create: `packages/agentbook-jurisdictions/src/au/company-tax.ts`
- Test: new `packages/agentbook-jurisdictions/src/__tests__/au-company-tax.test.ts`

**Interfaces:**
- Consumes: `TaxBracketProvider`, `TaxBracket`, `TaxCalculation` from `../interfaces.js` (already defined, already implemented identically by `au/tax-brackets.ts` — read that file as the structural reference).
- Produces: `export const auCompanyTaxBrackets: TaxBracketProvider` with `jurisdiction: 'au'`, `getTaxBrackets(taxYear): TaxBracket[]`, `calculateTax(taxableIncomeCents: number, taxYear: number): TaxCalculation`.

- [ ] **Step 1: Write the failing test**

Create `packages/agentbook-jurisdictions/src/__tests__/au-company-tax.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { auCompanyTaxBrackets } from '../au/company-tax.js';

describe('AU Company Tax (flat "base rate entity" rate)', () => {
  it('has jurisdiction set to "au"', () => {
    expect(auCompanyTaxBrackets.jurisdiction).toBe('au');
  });

  it('applies a flat 25% to $80,000 taxable income — no tax-free threshold, unlike individual brackets', () => {
    // $80,000 = 8,000,000 cents. Flat 25% = 2,000,000 cents ($20,000).
    // Contrast with the individual auTaxBrackets result for the same
    // income (1,478,800 cents income tax, per au-pack.test.ts) — a
    // company pays MORE tax at this income level because it has no
    // $18,200 tax-free threshold, which is real and expected, not a bug.
    const result = auCompanyTaxBrackets.calculateTax(8_000_000, 2025);
    expect(result.taxCents).toBe(2_000_000);
    expect(result.marginalRate).toBe(0.25);
    expect(result.effectiveRate).toBeCloseTo(0.25, 5);
  });

  it('flat rate is invariant of income level — no tiers, no tax-free threshold', () => {
    const low = auCompanyTaxBrackets.calculateTax(100_000, 2025); // $1,000
    const high = auCompanyTaxBrackets.calculateTax(50_000_000, 2025); // $500,000
    expect(low.marginalRate).toBe(0.25);
    expect(high.marginalRate).toBe(0.25);
    expect(low.effectiveRate).toBeCloseTo(0.25, 5);
    expect(high.effectiveRate).toBeCloseTo(0.25, 5);
  });

  it('returns zero tax and zero effective rate for zero income', () => {
    const result = auCompanyTaxBrackets.calculateTax(0, 2025);
    expect(result.taxCents).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it('rounds to the nearest cent for an odd-cent income figure', () => {
    // 333 cents × 0.25 = 83.25 → rounds to 83.
    const result = auCompanyTaxBrackets.calculateTax(333, 2025);
    expect(result.taxCents).toBe(83);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-company-tax.test.ts`
Expected: FAIL — `../au/company-tax.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `packages/agentbook-jurisdictions/src/au/company-tax.ts`:

```typescript
import type { TaxBracketProvider, TaxBracket, TaxCalculation } from '../interfaces.js';

// ATO company tax rate for a "base rate entity" (aggregated turnover under
// $50M and no more than 80% passive income) — 25% for the 2024-25 income
// year. This is the rate that applies to essentially every tenant in this
// product's target persona (freelancers/micro-SMBs under ~$1M revenue).
// The 30% full company tax rate (for entities that don't qualify as a base
// rate entity) is NOT modeled — out of scope for this persona.
const AU_COMPANY_RATE = 0.25;
const AU_COMPANY_BRACKETS: TaxBracket[] = [
  { min: 0, max: null, rate: AU_COMPANY_RATE },
];

function calculateFromBrackets(incomeCents: number, brackets: TaxBracket[]): TaxCalculation {
  let totalTax = 0;
  const breakdown: TaxCalculation['bracketBreakdown'] = [];
  for (const bracket of brackets) {
    if (incomeCents <= bracket.min) break;
    const taxable = Math.min(incomeCents, bracket.max ?? Infinity) - bracket.min;
    const tax = Math.round(taxable * bracket.rate);
    totalTax += tax;
    breakdown.push({ bracket, taxCents: tax });
  }
  return {
    taxCents: totalTax,
    effectiveRate: incomeCents > 0 ? totalTax / incomeCents : 0,
    marginalRate: incomeCents > 0 ? AU_COMPANY_RATE : 0,
    bracketBreakdown: breakdown,
  };
}

export const auCompanyTaxBrackets: TaxBracketProvider = {
  jurisdiction: 'au',
  getTaxBrackets(taxYear: number) { return AU_COMPANY_BRACKETS; },
  calculateTax(taxableIncomeCents: number, taxYear: number) {
    return calculateFromBrackets(taxableIncomeCents, AU_COMPANY_BRACKETS);
  },
};
```

(This deliberately duplicates the small `calculateFromBrackets` loop already present in `au/tax-brackets.ts` rather than extracting a shared helper — matching this package's existing per-file convention of small, independently-readable jurisdiction files, and per this plan's Global Constraints, not introducing a new shared abstraction.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-company-tax.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agentbook-jurisdictions/src/au/company-tax.ts packages/agentbook-jurisdictions/src/__tests__/au-company-tax.test.ts
git commit -m "feat(jurisdictions): add AU flat company (Pty Ltd) tax rate provider"
```

---

### Task 2: Wire `taxEntityType` into the tax-estimate route

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`
- Test: `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts` (extend the existing file — read it first for the established mocking pattern, already covers `tenantConfigFindUnique`)

**Interfaces:**
- Consumes: `auCompanyTaxBrackets` (from Task 1).
- Produces: no new exports — the route's internal calculation branches on the existing `tenantConfig?.taxEntityType` (already fetched by the route's existing `db.abTenantConfig.findUnique` call — no new query needed) whenever `jurisdiction === 'au' && taxEntityType === 'pty_ltd'`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`, inside a new `describe('GET /agentbook-tax/tax/estimate — AU taxEntityType', ...)` block:

```typescript
describe('GET /agentbook-tax/tax/estimate — AU taxEntityType', () => {
  it('an AU Pty Ltd company gets the flat 25% company rate, not individual brackets + Medicare Levy', async () => {
    tenantConfigFindUnique.mockResolvedValue({
      jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual', taxEntityType: 'pty_ltd',
    });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 20_000_00 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();

    // Net income = $100,000 - $20,000 = $80,000 (8,000,000 cents).
    // Flat 25% company tax = 2,000,000 cents. No Medicare Levy (companies
    // don't pay individual Medicare Levy on retained business profit).
    expect(json.data.jurisdiction).toBe('au');
    expect(json.data.seTaxCents).toBe(0);
    expect(json.data.incomeTaxCents).toBe(2_000_000);
    expect(json.data.totalTaxCents).toBe(2_000_000);
  });

  it('an AU sole trader with the same income keeps the existing individual-bracket + Medicare Levy path unchanged', async () => {
    tenantConfigFindUnique.mockResolvedValue({
      jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual', taxEntityType: 'sole_trader',
    });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 20_000_00 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();

    // Same $80,000 net income via the unchanged individual path:
    // Medicare Levy = round(8,000,000 × 0.02) = 160,000 cents.
    // Income tax = 428,800 (16% bracket) + 1,050,000 (30% bracket) = 1,478,800 cents.
    expect(json.data.seTaxCents).toBe(160_000);
    expect(json.data.incomeTaxCents).toBe(1_478_800);
    expect(json.data.totalTaxCents).toBe(1_638_800);
  });

  it('an AU tenant with no taxEntityType set (null) also keeps the individual path — pty_ltd is opt-in, not a silent default', async () => {
    tenantConfigFindUnique.mockResolvedValue({
      jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual', taxEntityType: null,
    });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 20_000_00 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.totalTaxCents).toBe(1_638_800); // same as sole_trader
  });

  it('a US tenant with taxEntityType coincidentally set to "pty_ltd" (bad data / cross-jurisdiction leftover) is NOT given AU company treatment', async () => {
    tenantConfigFindUnique.mockResolvedValue({
      jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual', taxEntityType: 'pty_ltd',
    });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 20_000_00 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    // Must still resolve via the US bracket/SE-tax providers, not AU company tax.
    expect(json.data.jurisdiction).toBe('us');
    expect(json.data.seTaxCents).toBeGreaterThan(0); // US SE tax applies, unlike the AU-company $0 case
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`
Expected: FAIL on the first two new tests (pty_ltd currently gets the same individual-path numbers as sole_trader, since `taxEntityType` is never read) — the third and fourth should already pass unmodified (they describe today's actual behavior), confirming they're valid regression guards, not just copy-paste.

- [ ] **Step 3: Implement**

In `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`:

1. Add the import (alongside the other `@agentbook/jurisdictions` subpath imports):

```typescript
import { auCompanyTaxBrackets } from '@agentbook/jurisdictions/au/company-tax';
```

2. Change:

```typescript
    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const region = tenantConfig?.region || '';
```

to:

```typescript
    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const region = tenantConfig?.region || '';
    // An AU Pty Ltd company pays flat company tax, not individual brackets +
    // Medicare Levy — every other entity type (sole_trader, trust, unset)
    // and every non-AU jurisdiction is unaffected. Deliberately opt-in
    // (only 'pty_ltd' exactly) rather than "anything not sole_trader",
    // so an unset/null taxEntityType never silently gets company treatment.
    const isAuCompany = jurisdiction === 'au' && tenantConfig?.taxEntityType === 'pty_ltd';
```

3. Change:

```typescript
    const taxYear = startDate.getFullYear();
    const seTax = calcSelfEmploymentTax(netIncomeCents, jurisdiction, taxYear);
    const seTaxCents = seTax.amountCents;
    // Each jurisdiction's calculator already knows its own deductible
    // portion (half of US SE tax, the employer-equivalent CPP portion,
    // none for AU's non-deductible Medicare Levy) — no more us-only ternary.
    const seDeduction = seTax.deductiblePortionCents;
    const taxableIncomeCents = Math.max(0, netIncomeCents - seDeduction);
    const bracketProvider = BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets;
    // W-2 wages stack on top of self-employment income for bracket placement.
    // filingStatus (already stored per-tenant, default 'single') selects the
    // married-filing-jointly bracket table for US tenants; other jurisdiction
    // packs ignore the extra argument.
    const incomeTaxCents = bracketProvider.calculateTax(taxableIncomeCents + w2IncomeCents, taxYear, taxConfig?.filingStatus).taxCents;
    const totalTaxCents = seTaxCents + incomeTaxCents;
```

to:

```typescript
    const taxYear = startDate.getFullYear();
    // A Pty Ltd company doesn't pay individual Medicare Levy / self-
    // employment tax on retained business profit (that only applies to
    // wages/dividends an individual actually draws, which isn't modeled
    // here) — so self-employment tax is $0 for the AU-company branch.
    const seTax = isAuCompany
      ? { amountCents: 0, deductiblePortionCents: 0 }
      : calcSelfEmploymentTax(netIncomeCents, jurisdiction, taxYear);
    const seTaxCents = seTax.amountCents;
    // Each jurisdiction's calculator already knows its own deductible
    // portion (half of US SE tax, the employer-equivalent CPP portion,
    // none for AU's non-deductible Medicare Levy) — no more us-only ternary.
    const seDeduction = seTax.deductiblePortionCents;
    const taxableIncomeCents = Math.max(0, netIncomeCents - seDeduction);
    // A company's flat tax rate applies to its own net income only — the
    // tenant's personal W-2 wages don't stack onto a company's tax base
    // the way they stack onto an individual's bracket placement.
    const incomeTaxCents = isAuCompany
      ? auCompanyTaxBrackets.calculateTax(taxableIncomeCents, taxYear).taxCents
      : (BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets).calculateTax(taxableIncomeCents + w2IncomeCents, taxYear, taxConfig?.filingStatus).taxCents;
    const totalTaxCents = seTaxCents + incomeTaxCents;
```

(Note the inlined `BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets` replaces the old standalone `const bracketProvider = ...` line — it's now only needed inside the non-company branch, so there's no dangling unused variable.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`
Expected: PASS, all tests (both pre-existing and the 4 new ones).

- [ ] **Step 5: Run the full jurisdictions-package + tax/estimate suites for a final regression check**

Run: `cd packages/agentbook-jurisdictions && npx vitest run 2>&1 | tail -10` then `cd ../../apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts 2>&1 | tail -10`
Expected: PASS for both — confirms Task 1's new file didn't break any existing jurisdictions-package test, and the route's full test file (old + new) passes together.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts \
        apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts
git commit -m "feat(tax-estimate): apply the flat AU company rate when taxEntityType is pty_ltd"
```
