# AU Cashflow-Scenario Tax Fix (Roadmap PR AU-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "what-if" cashflow scenario tool (`POST /api/v1/agentbook-tax/cashflow/scenario`) computes real tax for every supported jurisdiction — currently an AU tenant gets literal `$0` self-employment tax and their income taxed against the US federal bracket table, and every tenant regardless of jurisdiction sees dollar amounts formatted as USD.

**Architecture:** `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` already solved this exact problem correctly (a prior roadmap PR replaced its own inline US/CA-only duplicate logic with the real, tested `packages/agentbook-jurisdictions` bracket/self-employment-tax providers, keyed by jurisdiction). This PR ports that same `BRACKET_PROVIDERS`/`SE_TAX_CALCULATORS` pattern into `cashflow/scenario/route.ts`, deleting the route's own duplicated, AU-blind `US_FEDERAL_BRACKETS`/`CA_FEDERAL_BRACKETS`/`calcProgressiveTax`/`calcTotalTax` in favor of calling the same jurisdiction-pack providers `tax/estimate` already uses. It also replaces the route's hardcoded `fmt()` (always `en-US`/`USD`) with the existing shared `formatCurrencyCents` helper (`apps/web-next/src/lib/jurisdiction-currency.ts`), reading the tenant's actual `currency`/`locale` from `AbTenantConfig` (already fetched by this route as `tenantConfig`).

**Tech Stack:** TypeScript, Next.js API routes, Vitest.

## Global Constraints

- **Reuse before rewrite:** do not hand-write new AU tax logic — import `auTaxBrackets`/`auSelfEmploymentTax` (and while at it, `usTaxBrackets`/`usSelfEmploymentTax`/`caTaxBrackets`/`caSelfEmploymentTax`) from `@agentbook/jurisdictions`, mirroring the exact import paths and `BRACKET_PROVIDERS`/`SE_TAX_CALCULATORS` map shape already used in `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`.
- **This also changes US/CA numeric behavior** (the shared jurisdiction-pack engine is more accurate than the route's own old duplicate — e.g. it applies the real US Social Security wage cap and Additional Medicare Tax, which the old inline `Math.round(netIncomeCents * 0.9235 * 0.153)` approximation didn't). This is intentional and matches how `tax/estimate/route.ts` already made the same trade when it adopted the shared engine — do not attempt to preserve the old US/CA numbers.
- **No schema migration needed.** `AbTenantConfig.currency`/`.locale` already exist with defaults `'USD'`/`'en-US'`.
- **No new abstraction layer.** Do not extract a shared helper module for `BRACKET_PROVIDERS`/`SE_TAX_CALCULATORS` used by both routes — that consolidation is a separate, out-of-scope refactor. Duplicate the small provider-map declaration in this route, exactly as it already exists in `tax/estimate/route.ts`.

---

### Task 1: Replace the inline US/CA-only tax engine with the shared jurisdiction-pack providers

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts`
- Test: new `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `usTaxBrackets`/`caTaxBrackets`/`auTaxBrackets` (each a `TaxBracketProvider` from `@agentbook/jurisdictions/interfaces` — `calculateTax(taxableIncomeCents: number, taxYear: number, filingStatus?: string): { taxCents: number; ... }`), `usSelfEmploymentTax`/`caSelfEmploymentTax`/`auSelfEmploymentTax` (each a `SelfEmploymentTaxCalculator` — `calculate(netIncomeCents: number, taxYear: number): { amountCents: number; deductiblePortionCents: number; breakdown: Record<string, number> }`). All six are already published, tested, and consumed the exact same way in `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` — read that file for the working reference.
- Produces: `calcTotalTax(netIncomeCents: number, jurisdiction: string, taxYear: number)` — same name, but the signature gains a `taxYear` parameter (the old version didn't take one since its inline brackets weren't year-versioned; the real jurisdiction-pack providers are).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineAggregate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abJournalLine: { aggregate: (...a: unknown[]) => journalLineAggregate(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://x/cashflow/scenario', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockImplementation(({ where }: { where: { accountType: string } }) =>
    Promise.resolve(where.accountType === 'revenue' ? [{ id: 'rev-1' }] : [{ id: 'exp-1' }]),
  );
});

describe('POST /agentbook-tax/cashflow/scenario — AU tax correctness', () => {
  it('an AU tenant with $80,000 net income gets real ATO bracket + Medicare Levy tax, not $0 / US brackets', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD', locale: 'en-AU' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    const res = await POST(postReq({ changeAmountCents: 0 }));
    const json = await res.json();

    // $80,000 AUD net income:
    //   Medicare Levy (SE tax) = 2% of 8,000,000 cents = 160,000 cents ($1,600)
    //     — well above the $32,500 shading-out threshold, so full 2% applies.
    //   Income tax (2024-25 ATO brackets): $0 on the first $18,200 (0%),
    //     16% on $18,201–$45,000 ($26,800 × 16% = $4,288 = 428,800 cents),
    //     30% on $45,001–$80,000 ($35,000 × 30% = $10,500 = 1,050,000 cents)
    //     = 1,478,800 cents total.
    //   Total tax = 160,000 + 1,478,800 = 1,638,800 cents.
    expect(json.data.currentTaxCents).toBe(1_638_800);
  });

  it('an AU tenant with net income below the Medicare Levy low-income threshold pays $0 self-employment tax but still real income tax', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD', locale: 'en-AU' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 20_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    const res = await POST(postReq({ changeAmountCents: 0 }));
    const json = await res.json();

    // $20,000 net income is below the $26,000 Medicare Levy low-income
    // threshold → Medicare Levy = $0. Income tax: $0 on first $18,200,
    // 16% on the remaining $1,800 = $288 = 28,800 cents.
    expect(json.data.currentTaxCents).toBe(28_800);
  });

  it('scenario/explanation strings use the tenant\'s configured currency, not a hardcoded USD "$"', async () => {
    // Note: AUD formatted with an 'en-AU' locale renders as a plain "$",
    // visually identical to USD — that's correct `Intl` behavior, not a
    // bug, so it's not a useful discriminating check. GBP/en-GB renders
    // as "£", which unambiguously proves the tenant's real currency/
    // locale reached `fmt()` instead of a hardcoded 'USD'/'en-US'.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'GBP', locale: 'en-GB' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    // Add a £10,000 deductible expense — should read "Adding £10,000 ..." not "Adding $10,000.00 ...".
    const res = await POST(postReq({ changeAmountCents: 10_000_00 }));
    const json = await res.json();

    expect(json.data.scenario).toMatch(/£10,000/);
    expect(json.data.scenario).not.toMatch(/\$/);
  });

  it('US and CA scenarios still compute a positive, real tax figure (no jurisdiction lost a working calculation)', async () => {
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD', locale: 'en-US' });
    const { POST } = await import('../route');
    const resUs = await POST(postReq({ changeAmountCents: 0 }));
    const jsonUs = await resUs.json();
    expect(jsonUs.data.currentTaxCents).toBeGreaterThan(0);

    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', currency: 'CAD', locale: 'en-CA' });
    const resCa = await POST(postReq({ changeAmountCents: 0 }));
    const jsonCa = await resCa.json();
    expect(jsonCa.data.currentTaxCents).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts`
Expected: FAIL — the AU tests currently get `currentTaxCents` computed from `seTax=0` + US federal brackets (wrong numbers, not `1_638_800`/`28_800`), and the currency test currently gets a `$`-prefixed USD string, not `A$`.

- [ ] **Step 3: Implement**

In `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts`, replace the entire block from `const US_FEDERAL_BRACKETS = [` through the end of `function calcTotalTax(...)` (i.e. delete `US_FEDERAL_BRACKETS`, `CA_FEDERAL_BRACKETS`, `calcProgressiveTax`, and the old `calcTotalTax`) with:

```typescript
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import { usSelfEmploymentTax } from '@agentbook/jurisdictions/us/self-employment-tax';
import { caSelfEmploymentTax } from '@agentbook/jurisdictions/ca/self-employment-tax';
import { auSelfEmploymentTax } from '@agentbook/jurisdictions/au/self-employment-tax';
import type { TaxBracketProvider, SelfEmploymentTaxCalculator } from '@agentbook/jurisdictions/interfaces';

// Real, tested jurisdiction-pack logic — same providers `tax/estimate/route.ts`
// uses, replacing this route's own previously-duplicated, less-accurate
// US/CA-only inline brackets and the silent "$0 SE tax, US brackets"
// fallback for every other jurisdiction, including au.
const BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};
const SE_TAX_CALCULATORS: Record<string, SelfEmploymentTaxCalculator> = {
  us: usSelfEmploymentTax,
  ca: caSelfEmploymentTax,
  au: auSelfEmploymentTax,
};

function calcTotalTax(netIncomeCents: number, jurisdiction: string, taxYear: number): number {
  if (netIncomeCents <= 0) return 0;
  const seCalculator = SE_TAX_CALCULATORS[jurisdiction];
  const se = seCalculator ? seCalculator.calculate(netIncomeCents, taxYear) : { amountCents: 0, deductiblePortionCents: 0 };
  const taxable = Math.max(0, netIncomeCents - se.deductiblePortionCents);
  const bracketProvider = BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets;
  const incomeTaxCents = bracketProvider.calculateTax(taxable, taxYear).taxCents;
  return se.amountCents + incomeTaxCents;
}
```

Note the import paths mirror `tax/estimate/route.ts` exactly (subpath imports into the `@agentbook/jurisdictions` package, not the root index) — this is the already-working, already-deployed pattern.

- [ ] **Step 4: Thread `taxYear` and the tenant's currency/locale through the route handler**

Still in `cashflow/scenario/route.ts`, inside `POST`, change:

```typescript
    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();
```

to:

```typescript
    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const currency = tenantConfig?.currency || 'USD';
    const locale = tenantConfig?.locale || 'en-US';
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();
    const taxYear = now.getFullYear();
```

Then update the two `calcTotalTax(...)` call sites to pass `taxYear` as the third argument:

```typescript
    const currentTaxCents = calcTotalTax(netIncomeCents, jurisdiction, taxYear);
    ...
    const projectedTaxCents = calcTotalTax(projectedNetIncome, jurisdiction, taxYear);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts`
Expected: still FAIL on the two currency-format assertions (Task 2 handles those) but PASS on the AU/US/CA tax-figure assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts \
        apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts
git commit -m "fix(cashflow): compute real per-jurisdiction tax in the what-if scenario tool"
```

---

### Task 2: Replace the hardcoded USD `fmt()` with the tenant's real currency/locale

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts`

**Interfaces:**
- Consumes: `formatCurrencyCents(cents: number, currency?: string | null, locale?: string | null): string` from `apps/web-next/src/lib/jurisdiction-currency.ts` (already implemented, already used elsewhere — read that file for its exact behavior; it falls back to USD/en-US internally on an invalid currency/locale, so no extra guarding is needed at the call site).
- Produces: no new exports — `fmt()` stays a local closure inside this route file, just no longer hardcoded.

- [ ] **Step 1: Implement**

In `apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts`:

1. Add the import (alongside the other `@/lib/...` imports at the top):

```typescript
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
```

2. Delete the module-level `function fmt(cents: number): string { ... }` (it hardcodes `en-US`/`USD`).

3. Inside `POST`, immediately after the `const taxYear = now.getFullYear();` line added in Task 1 Step 4, add a per-request `fmt` closure that captures the tenant's real `currency`/`locale`:

```typescript
    const fmt = (cents: number): string => formatCurrencyCents(cents, currency, locale);
```

(This must be declared after `currency`/`locale` are resolved and before the first call to `fmt(...)` later in the function — the existing calls to `fmt(changeAmountCents)` etc. lower in the function body are unchanged and will now pick up the closure.)

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts`
Expected: PASS, all tests including the currency-format assertion (`A$10,000`, `maximumFractionDigits: 0` per `formatCurrencyCents`'s own implementation — confirm the exact expected string format by reading `formatCurrencyCents` in `apps/web-next/src/lib/jurisdiction-currency.ts` if the assertion needs adjusting to match its real rounding/symbol behavior for `en-AU`/`AUD`).

- [ ] **Step 3: Run the full route test suite plus a broader regression check**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/cashflow/scenario/__tests__/route.test.ts src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts 2>&1 | tail -10`
Expected: PASS for both files — confirms this change didn't regress the sibling `tax/estimate` route (it shouldn't, since no shared file besides the jurisdictions package itself was touched, and that package's exports weren't modified).

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts
git commit -m "fix(cashflow): format scenario amounts in the tenant's real currency, not hardcoded USD"
```
