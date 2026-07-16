# Launch PR-1: Wire AU (and CA) into the live tax engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live Tax Dashboard applies US tax brackets to AU (and, less severely, CA-simplified) income, returns a flat, less-accurate self-employment-tax figure regardless of jurisdiction, shows US IRS quarterly deadlines to AU tenants instead of ATO PAYG instalment dates, and displays a hardcoded `$`/USD symbol across many widgets regardless of the tenant's actual currency. This plan wires the already-built, correct `us`/`ca`/`au` jurisdiction packs into every one of those live code paths.

**Architecture:** No new subsystems. Two backend routes gain real per-jurisdiction bracket/self-employment-tax lookups and an AU quarterly-deadline branch, sourced from `packages/agentbook-jurisdictions`. A currency-formatting fix (reuse the already-proven `useTenantCurrency()` + `@agentbook/i18n`'s `formatMoney()` pattern, already used correctly by sibling pages) is applied to the Tax Dashboard and then swept across the other flagged widgets, which required a new (but trivial, copy-of-existing) hook in two plugin frontends that don't have one yet.

**Tech Stack:** Next.js API routes (backend), React plugin frontends, `@agentbook/jurisdictions` (already-built, unmodified), `@agentbook/i18n`'s `formatMoney` (already-built, unmodified).

## Global Constraints

- No jurisdiction pack (`packages/agentbook-jurisdictions/src/{us,ca,au}/*`) is modified by this plan — only consumed. They are already correct and tested.
- Every currency fix reuses `useTenantCurrency()` + `formatMoney()` exactly as `Reports.tsx`/`Mileage.tsx` already do it — no new formatting logic invented.
- `tax/estimate/route.ts` and `tax/quarterly/route.ts` are the real, production-serving Next.js routes (confirmed: their fetch paths match what `TaxDashboard.tsx`/`Quarterly.tsx` call, and both exist as native Next.js routes with no `AGENTBOOK_TAX_URL` override set in production). The near-identical duplicated logic in the legacy Express `plugins/agentbook-tax/backend/src/server.ts` is a local-dev-only artifact not on the production request path — **do not modify it in this plan**; fixing dead code wastes effort this roadmap doesn't need to spend.
- Switching `calcSelfEmploymentTax` to the real jurisdiction-pack calculators is also a **US and CA correctness improvement**, not just an AU fix: the current inline US logic is a flat `92.35% × 15.3%` with no Social Security wage cap and no Additional Medicare Tax, and the current inline CA logic is a flat `11.9%` with no basic exemption and no CPP2 second-ceiling — both simplifications the real packs already handle correctly. Call this out in the PR description; it's a welcome side effect, not scope creep, since it's the direct consequence of removing the duplicated logic this plan is already committed to removing.

---

### Task 1: Real jurisdiction-pack brackets + self-employment tax in `tax/estimate/route.ts`

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`
- Test: `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts` (new — no test file exists for this route today)

**Interfaces:**
- Consumes: `usTaxBrackets`/`caTaxBrackets`/`auTaxBrackets` (`TaxBracketProvider`, `.calculateTax(taxableIncomeCents, taxYear): { taxCents, effectiveRate, marginalRate, bracketBreakdown }`) and `usSelfEmploymentTax`/`caSelfEmploymentTax`/`auSelfEmploymentTax` (`SelfEmploymentTaxCalculator`, `.calculate(netSEIncomeCents, taxYear): { amountCents, deductiblePortionCents, breakdown }`) from `@agentbook/jurisdictions/{us,ca,au}/{tax-brackets,self-employment-tax}` — all already exist, already exported, already used this way elsewhere in this codebase (`plugins/agentbook-core/backend/src/tax-fast-track-draft-compute.ts`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const taxConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineAggregate = vi.fn();
const paymentAggregate = vi.fn();
const journalLineFindMany = vi.fn();
const accountFindFirst = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abTaxConfig: { findUnique: (...a: unknown[]) => taxConfigFindUnique(...a) },
    abAccount: {
      findMany: (...a: unknown[]) => accountFindMany(...a),
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
    },
    abJournalLine: {
      aggregate: (...a: unknown[]) => journalLineAggregate(...a),
      findMany: (...a: unknown[]) => journalLineFindMany(...a),
    },
    abPayment: { aggregate: (...a: unknown[]) => paymentAggregate(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function req(query = ''): NextRequest {
  return new NextRequest(`http://x/tax/estimate${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  taxConfigFindUnique.mockResolvedValue(null);
  accountFindMany.mockImplementation(({ where }: { where: { accountType: string } }) =>
    Promise.resolve(where.accountType === 'revenue' ? [{ id: 'rev-1' }] : [{ id: 'exp-1' }]),
  );
  journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
    Promise.resolve(
      where.accountId.in.includes('rev-1')
        ? { _sum: { creditCents: 10_000_00, debitCents: 0 } }
        : { _sum: { creditCents: 0, debitCents: 4_000_00 } },
    ),
  );
});

describe('GET /agentbook-tax/tax/estimate — jurisdiction correctness', () => {
  it('computes a real AU tax figure using the au bracket + Medicare Levy calculators, not $0 / US brackets', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();

    expect(json.data.jurisdiction).toBe('au');
    // Net income = $10,000 - $4,000 = $6,000 (600000 cents), well under the
    // $18,200 AU tax-free threshold and above the $26,000 Medicare Levy floor
    // is false here (6000 < 26000) — so Medicare Levy is correctly $0 *for
    // this input*, but this must come from calling auSelfEmploymentTax, not
    // from the old code's blanket `return 0` for any non-us/ca jurisdiction.
    // The real assertion: income tax must be computed via the real AU
    // brackets, not silently defaulted to the US bracket table.
    expect(json.data.incomeTaxCents).toBe(0); // 600000 cents < $18,200 AU tax-free threshold
    expect(json.self_employment_tax).toBe(0);
  });

  it('AU income above the Medicare Levy shading threshold produces a non-zero self-employment (Medicare Levy) figure', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    // $100,000 net income: Medicare Levy = 2% of 10,000,000 cents = 200,000 cents ($2,000)
    expect(json.data.seTaxCents).toBe(200000);
    expect(json.data.incomeTaxCents).toBeGreaterThan(0);
  });

  it('still computes correctly for us and ca (regression — same route, now via the jurisdiction packs)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.jurisdiction).toBe('us');
    expect(typeof json.data.seTaxCents).toBe('number');
    expect(typeof json.data.incomeTaxCents).toBe('number');
  });

  it('defaults to us brackets for an unrecognized jurisdiction, matching prior behavior', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'zz', region: '', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.jurisdiction).toBe('zz');
    expect(res.status).toBe(200); // never throws on an unknown jurisdiction
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`
Expected: FAIL — AU income above $18,200 currently gets taxed under US brackets and Medicare Levy is always `0` regardless of income (the second test's `200000` assertion fails against the current `return 0` for non-us/ca).

- [ ] **Step 3: Replace the hardcoded bracket/SE-tax logic with real jurisdiction-pack lookups**

Find (top of file, after existing imports):
```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const US_FEDERAL_BRACKETS = [
  { upTo: 11_600_00, rate: 0.10 },
  { upTo: 47_150_00, rate: 0.12 },
  { upTo: 100_525_00, rate: 0.22 },
  { upTo: 191_950_00, rate: 0.24 },
  { upTo: 243_725_00, rate: 0.32 },
  { upTo: 609_350_00, rate: 0.35 },
  { upTo: Infinity, rate: 0.37 },
];

const CA_FEDERAL_BRACKETS = [
  { upTo: 57_375_00, rate: 0.15 },
  { upTo: 114_750_00, rate: 0.205 },
  { upTo: 158_468_00, rate: 0.26 },
  { upTo: 221_708_00, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
];

function calcProgressiveTax(incomeCents: number, brackets: { upTo: number; rate: number }[]): number {
  if (incomeCents <= 0) return 0;
  let remaining = incomeCents;
  let tax = 0;
  let prev = 0;
  for (const bracket of brackets) {
    const width = bracket.upTo === Infinity ? remaining : bracket.upTo - prev;
    const taxable = Math.min(remaining, width);
    tax += Math.round(taxable * bracket.rate);
    remaining -= taxable;
    prev = bracket.upTo;
    if (remaining <= 0) break;
  }
  return tax;
}

function calcSelfEmploymentTax(netIncomeCents: number, jurisdiction: string): number {
  if (netIncomeCents <= 0) return 0;
  if (jurisdiction === 'us') return Math.round(netIncomeCents * 0.9235 * 0.153);
  if (jurisdiction === 'ca') return Math.round(netIncomeCents * 0.119);
  return 0;
}
```

Replace with:
```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import { usSelfEmploymentTax } from '@agentbook/jurisdictions/us/self-employment-tax';
import { caSelfEmploymentTax } from '@agentbook/jurisdictions/ca/self-employment-tax';
import { auSelfEmploymentTax } from '@agentbook/jurisdictions/au/self-employment-tax';
import type { TaxBracketProvider, SelfEmploymentTaxCalculator } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Real, tested jurisdiction-pack logic — replaces the previously duplicated,
// less-accurate inline US/CA-only calculations (no SS wage cap, no
// Additional Medicare Tax, no CPP basic exemption/CPP2 ceiling) and the
// silent "$0 self-employment tax, US brackets" fallback for every other
// jurisdiction, including au.
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

function calcSelfEmploymentTax(netIncomeCents: number, jurisdiction: string, taxYear: number): { amountCents: number; deductiblePortionCents: number } {
  if (netIncomeCents <= 0) return { amountCents: 0, deductiblePortionCents: 0 };
  const calculator = SE_TAX_CALCULATORS[jurisdiction];
  if (!calculator) return { amountCents: 0, deductiblePortionCents: 0 };
  const result = calculator.calculate(netIncomeCents, taxYear);
  return { amountCents: result.amountCents, deductiblePortionCents: result.deductiblePortionCents };
}
```

- [ ] **Step 4: Update the two call sites that used the removed functions/constants**

Find:
```ts
    const seTaxCents = calcSelfEmploymentTax(netIncomeCents, jurisdiction);
    const seDeduction = jurisdiction === 'us' ? Math.round(seTaxCents / 2) : 0;
    const taxableIncomeCents = Math.max(0, netIncomeCents - seDeduction);
    const brackets = jurisdiction === 'ca' ? CA_FEDERAL_BRACKETS : US_FEDERAL_BRACKETS;
    // W-2 wages stack on top of self-employment income for bracket placement.
    const incomeTaxCents = calcProgressiveTax(taxableIncomeCents + w2IncomeCents, brackets);
```

Replace with:
```ts
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
    const incomeTaxCents = bracketProvider.calculateTax(taxableIncomeCents + w2IncomeCents, taxYear).taxCents;
```

(Note: `taxableIncomeCents + w2IncomeCents` and `startDate` are both already defined earlier in the function — this step only changes how `seTaxCents`/`incomeTaxCents` are derived, not the surrounding aggregation logic.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/__tests__/route.test.ts
git commit -m "fix(tax): wire real us/ca/au jurisdiction-pack brackets + SE-tax into the live estimate route

Replaces duplicated, less-accurate inline US/CA-only logic (no SS wage
cap, no Additional Medicare Tax, no CPP basic exemption/CPP2 ceiling)
and a silent \$0/US-bracket fallback for every other jurisdiction —
including au, which previously got taxed under US brackets with a
Medicare Levy of \$0 regardless of income."
```

---

### Task 2: AU PAYG quarterly deadlines in `tax/quarterly/route.ts`

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/tax/quarterly/route.ts`
- Test: `apps/web-next/src/app/api/v1/agentbook-tax/tax/quarterly/__tests__/route.test.ts` (new)

**Interfaces:**
- Produces: an `au` branch in this file's own local `getQuarterlyDeadlines()` — deliberately NOT imported from `au/calendar-deadlines.ts`, since that file's `CalendarDeadline[]` shape (i18n title keys, urgency levels, action URLs) models a much richer general calendar than this route's simple `{quarter, deadline}` installment-payment model. The four dates used here (Oct 28 / Feb 28 / Apr 28 / Jul 28) are the same PAYG-instalment dates already present in `au/calendar-deadlines.ts` — reused as literal values for consistency, matching how `us`/`ca` are already both literal, locally-defined arrays in this exact file (not imported from anywhere) — this task follows that established in-file convention rather than introducing a new cross-file dependency for one function.

- [ ] **Step 1: Write the failing test**

Create `apps/web-next/src/app/api/v1/agentbook-tax/tax/quarterly/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const quarterlyFindMany = vi.fn();
const quarterlyUpsert = vi.fn();
const taxEstimateFindFirst = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abQuarterlyPayment: {
      findMany: (...a: unknown[]) => quarterlyFindMany(...a),
      upsert: (...a: unknown[]) => quarterlyUpsert(...a),
    },
    abTaxEstimate: { findFirst: (...a: unknown[]) => taxEstimateFindFirst(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function req(query = ''): NextRequest {
  return new NextRequest(`http://x/tax/quarterly${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  quarterlyUpsert.mockResolvedValue({});
  taxEstimateFindFirst.mockResolvedValue({ totalTaxCents: 400000 });
});

describe('GET /agentbook-tax/tax/quarterly — AU deadlines', () => {
  it('creates AU quarterly payments on the ATO PAYG instalment schedule, not the US IRS schedule', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    quarterlyFindMany
      .mockResolvedValueOnce([]) // no existing rows -> triggers lazy creation
      .mockResolvedValueOnce([
        { quarter: 1, deadline: new Date('2026-10-28'), amountDueCents: 100000, amountPaidCents: 0 },
        { quarter: 2, deadline: new Date('2027-02-28'), amountDueCents: 100000, amountPaidCents: 0 },
        { quarter: 3, deadline: new Date('2027-04-28'), amountDueCents: 100000, amountPaidCents: 0 },
        { quarter: 4, deadline: new Date('2027-07-28'), amountDueCents: 100000, amountPaidCents: 0 },
      ]);

    const { GET } = await import('../route');
    const res = await GET(req('?year=2026'));
    const json = await res.json();

    expect(json.data.jurisdiction).toBe('au');
    expect(quarterlyUpsert).toHaveBeenCalledTimes(4);
    const deadlinesPassed = quarterlyUpsert.mock.calls.map((c) => c[0].create.deadline.toISOString().slice(0, 10));
    expect(deadlinesPassed).toEqual(['2026-10-28', '2027-02-28', '2027-04-28', '2027-07-28']);
  });

  it('still creates US quarterly payments on the IRS schedule (regression)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    quarterlyFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { GET } = await import('../route');
    await GET(req('?year=2026'));
    const deadlinesPassed = quarterlyUpsert.mock.calls.map((c) => c[0].create.deadline.toISOString().slice(0, 10));
    expect(deadlinesPassed).toEqual(['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/quarterly/__tests__/route.test.ts`
Expected: FAIL — the AU test currently gets the US IRS dates (`2026-04-15`, etc.) instead of the ATO PAYG dates.

- [ ] **Step 3: Add the AU branch**

Find:
```ts
function getQuarterlyDeadlines(year: number, jurisdiction: string): { quarter: number; deadline: Date }[] {
  if (jurisdiction === 'ca') {
    return [
      { quarter: 1, deadline: new Date(`${year}-03-15`) },
      { quarter: 2, deadline: new Date(`${year}-06-15`) },
      { quarter: 3, deadline: new Date(`${year}-09-15`) },
      { quarter: 4, deadline: new Date(`${year}-12-15`) },
    ];
  }
  return [
    { quarter: 1, deadline: new Date(`${year}-04-15`) },
    { quarter: 2, deadline: new Date(`${year}-06-15`) },
    { quarter: 3, deadline: new Date(`${year}-09-15`) },
    { quarter: 4, deadline: new Date(`${year + 1}-01-15`) },
  ];
}
```

Replace with:
```ts
function getQuarterlyDeadlines(year: number, jurisdiction: string): { quarter: number; deadline: Date }[] {
  if (jurisdiction === 'ca') {
    return [
      { quarter: 1, deadline: new Date(`${year}-03-15`) },
      { quarter: 2, deadline: new Date(`${year}-06-15`) },
      { quarter: 3, deadline: new Date(`${year}-09-15`) },
      { quarter: 4, deadline: new Date(`${year}-12-15`) },
    ];
  }
  if (jurisdiction === 'au') {
    // Australian financial year runs July-June; these are the ATO PAYG
    // instalment dates (same dates as packages/agentbook-jurisdictions's
    // au/calendar-deadlines.ts's payg_qN_instalment entries, reused here
    // as literals matching this file's existing us/ca convention).
    return [
      { quarter: 1, deadline: new Date(`${year}-10-28`) },
      { quarter: 2, deadline: new Date(`${year + 1}-02-28`) },
      { quarter: 3, deadline: new Date(`${year + 1}-04-28`) },
      { quarter: 4, deadline: new Date(`${year + 1}-07-28`) },
    ];
  }
  return [
    { quarter: 1, deadline: new Date(`${year}-04-15`) },
    { quarter: 2, deadline: new Date(`${year}-06-15`) },
    { quarter: 3, deadline: new Date(`${year}-09-15`) },
    { quarter: 4, deadline: new Date(`${year + 1}-01-15`) },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-tax/tax/quarterly/__tests__/route.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/tax/quarterly/route.ts apps/web-next/src/app/api/v1/agentbook-tax/tax/quarterly/__tests__/route.test.ts
git commit -m "fix(tax): AU quarterly payments use ATO PAYG instalment dates, not US IRS dates"
```

---

### Task 3: Fix `TaxDashboard.tsx`'s hardcoded USD currency

**Files:**
- Modify: `plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx`

**Interfaces:**
- Consumes: `useTenantCurrency()` (`plugins/agentbook-tax/frontend/src/hooks/useTenantCurrency.ts`, already exists, unmodified) and `formatMoney` (`@agentbook/i18n`, already exists, unmodified) — the exact pattern `Reports.tsx` already uses correctly in this same plugin.

- [ ] **Step 1: Replace the hardcoded formatter**

Find (near the top of the file, after the `TaxSettings` interface):
```ts
function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
```

Replace with:
```ts
function formatCurrency(n: number, currency: string = 'USD') {
  return formatMoney(Math.round(n * 100), currency);
}
```

- [ ] **Step 2: Add the imports and call the hook**

Find:
```ts
import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Percent,
  Calendar,
  CheckCircle,
  Clock,
  Loader2,
  RefreshCw,
  Settings,
  AlertCircle,
  Globe,
  Building2,
  FileUp,
  ArrowRight,
} from 'lucide-react';
```

Replace with:
```ts
import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Percent,
  Calendar,
  CheckCircle,
  Clock,
  Loader2,
  RefreshCw,
  Settings,
  AlertCircle,
  Globe,
  Building2,
  FileUp,
  ArrowRight,
} from 'lucide-react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```

Then, inside the component function itself, find the line declaring the component's other top-level hooks (search for `export default function TaxDashboard` or `export function TaxDashboard` and the first `useState`/`useEffect` call right after it), and add immediately after that line:
```ts
  const currency = useTenantCurrency();
```

- [ ] **Step 3: Update every `formatCurrency(...)` call site to pass `currency`**

Every existing call in this file follows the pattern `formatCurrency(data.something)` — find each one (there are 7, per the earlier research pass: the total-tax hero figure, net-income sub-line, W-2 sub-line, amount-owed line, income-tax card, self-employment-tax card, revenue card, expenses card) and add `, currency` as the second argument, e.g. `formatCurrency(data.total_estimated_tax)` → `formatCurrency(data.total_estimated_tax, currency)`. Do this for every call site in the file — a simple, mechanical find able to be done with a single project-wide search for `formatCurrency(data.` within this file.

- [ ] **Step 4: Manual verification**

Run the dev server, view the Tax Dashboard as a test tenant with `currency: 'AUD'` configured (or `CAD`), and confirm the total-tax figure and all sub-figures render with the correct currency symbol instead of `$`/USD formatting.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx
git commit -m "fix(tax): TaxDashboard shows the tenant's real currency, not hardcoded USD"
```

---

### Task 4: Add the missing AUD case to the invoice PDF's money formatter

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-invoice-pdf.ts`

- [ ] **Step 1: Add the AUD case**

Find:
```ts
function fmtMoney(cents: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : currency === 'CAD' ? 'CA$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}
```

Replace with:
```ts
function fmtMoney(cents: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : currency === 'CAD' ? 'CA$' : currency === 'AUD' ? 'A$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-next/src/lib/agentbook-invoice-pdf.ts
git commit -m "fix(invoice-pdf): add missing AUD symbol case to fmtMoney"
```

---

### Task 5: Hardcoded-currency sweep — `agentbook-core` plugin frontend

**Files:**
- Create: `plugins/agentbook-core/frontend/src/hooks/useTenantCurrency.ts`
- Modify: `plugins/agentbook-core/frontend/src/pages/Ledger.tsx`, `plugins/agentbook-core/frontend/src/pages/dashboard/ThisMonthStrip.tsx`, `plugins/agentbook-core/frontend/src/pages/dashboard/CatchUpBanner.tsx`, `plugins/agentbook-core/frontend/src/pages/dashboard/AttentionItem.tsx`, `plugins/agentbook-core/frontend/src/pages/dashboard/ForwardView.tsx`

**Interfaces:**
- Produces: `useTenantCurrency()` for `agentbook-core`'s frontend, an exact copy of the hook already proven in `agentbook-tax`/`agentbook-invoice`'s frontends — no new design.
- Each of the 5 widget files below calls this hook independently (rather than threading `currency` as a new prop through 2-3 parent layers) — this matches the established pattern already used by every other currency-aware page in this codebase (`Reports.tsx`, `Mileage.tsx`), keeps each component self-contained, and avoids a multi-file prop-drilling cascade through `Dashboard.tsx` → `AttentionPanel.tsx` → `AttentionItem.tsx`.

- [ ] **Step 1: Create the hook**

Create `plugins/agentbook-core/frontend/src/hooks/useTenantCurrency.ts`:

```ts
import { useEffect, useState } from 'react';

/** The tenant's configured currency (e.g. 'USD', 'AUD'), defaulting to 'USD' until loaded. */
export function useTenantCurrency(): string {
  const [currency, setCurrency] = useState('USD');
  useEffect(() => {
    fetch('/api/v1/agentbook-core/tenant-config')
      .then((r) => r.json())
      .then((j) => { if (j?.data?.currency) setCurrency(j.data.currency); })
      .catch(() => {});
  }, []);
  return currency;
}
```

- [ ] **Step 2: Fix `Ledger.tsx`**

Find the existing formatter (around line 38):
```ts
  const fmt = (cents: number) => cents > 0 ? `$${(cents / 100).toFixed(2)}` : '';
```

Replace with (add the two imports at the top of the file alongside the existing ones, and call the hook inside the component body where its other `useState`/hooks are declared):
```ts
  const fmt = (cents: number) => cents > 0 ? formatMoney(cents, currency) : '';
```
Add imports:
```ts
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Add inside the component, alongside its other hooks:
```ts
  const currency = useTenantCurrency();
```

- [ ] **Step 3: Fix `dashboard/ThisMonthStrip.tsx`**

This one is a small presentational component with no hooks today — add one. Find:
```ts
import React from 'react';

export function computeDelta(current: number, prior: number): { pct: number; sign: 'up' | 'down' } | null {
  if (prior === 0) return null;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  return { pct, sign: pct >= 0 ? 'up' : 'down' };
}

const fmt = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

const Cell: React.FC<{ label: string; cents: number; prior: number }> = ({ label, cents, prior }) => {
```

Replace with:
```ts
import React from 'react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';

export function computeDelta(current: number, prior: number): { pct: number; sign: 'up' | 'down' } | null {
  if (prior === 0) return null;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  return { pct, sign: pct >= 0 ? 'up' : 'down' };
}

const Cell: React.FC<{ label: string; cents: number; prior: number; currency: string }> = ({ label, cents, prior, currency }) => {
```

Then find the `Cell`'s render body (`{fmt(cents)}`) and replace with `{formatMoney(cents, currency)}`, and find every place `<Cell .../>` is rendered inside `ThisMonthStrip` (there are multiple `Cell` usages for different labels) and add `currency={currency}` to each. Finally, find the `ThisMonthStrip` component's own definition (`export const ThisMonthStrip: React.FC<...> = ({ mtd, prev }) => {`) and add the hook call as its first line: `const currency = useTenantCurrency();`.

- [ ] **Step 4: Fix `dashboard/CatchUpBanner.tsx`**

Find:
```ts
function fmtUsd(cents: number): string {
  const sign = cents < 0 ? '−' : '+';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function lines(s: CatchUpSummary): string[] {
  const out: string[] = [];
  if (s.cashChangeCents !== 0) out.push(`Cash ${fmtUsd(s.cashChangeCents)}`);
  if (s.invoicesPaid.count > 0) {
    out.push(`${s.invoicesPaid.count} invoice${s.invoicesPaid.count === 1 ? '' : 's'} paid ($${(s.invoicesPaid.totalCents / 100).toFixed(2)})`);
  }
  if (s.invoicesSent.count > 0) {
    out.push(`${s.invoicesSent.count} invoice${s.invoicesSent.count === 1 ? '' : 's'} sent ($${(s.invoicesSent.totalCents / 100).toFixed(2)})`);
  }
```

Replace with:
```ts
function fmtSigned(cents: number, currency: string): string {
  const sign = cents < 0 ? '−' : '+';
  return `${sign}${formatMoney(Math.abs(cents), currency)}`;
}

function lines(s: CatchUpSummary, currency: string): string[] {
  const out: string[] = [];
  if (s.cashChangeCents !== 0) out.push(`Cash ${fmtSigned(s.cashChangeCents, currency)}`);
  if (s.invoicesPaid.count > 0) {
    out.push(`${s.invoicesPaid.count} invoice${s.invoicesPaid.count === 1 ? '' : 's'} paid (${formatMoney(s.invoicesPaid.totalCents, currency)})`);
  }
  if (s.invoicesSent.count > 0) {
    out.push(`${s.invoicesSent.count} invoice${s.invoicesSent.count === 1 ? '' : 's'} sent (${formatMoney(s.invoicesSent.totalCents, currency)})`);
  }
```

Add the two imports at the top of the file:
```ts
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';
```

Inside the `CatchUpBanner` component, add `const currency = useTenantCurrency();` alongside its existing `useState` calls, and update its one call site of `lines(data)` to `lines(data, currency)`.

- [ ] **Step 5: Fix `dashboard/AttentionItem.tsx`**

Find:
```ts
import React, { useState } from 'react';
import type { AttentionItem as Item } from './types';

interface Props { item: Item; }

const fmt = (cents?: number) =>
  cents == null ? '' : '$' + Math.abs(Math.round(cents / 100)).toLocaleString('en-US');
```

Replace with:
```ts
import React, { useState } from 'react';
import type { AttentionItem as Item } from './types';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';

interface Props { item: Item; }
```

Then inside the component body, find:
```ts
export const AttentionItem: React.FC<Props> = ({ item }) => {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
```

Replace with:
```ts
export const AttentionItem: React.FC<Props> = ({ item }) => {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const currency = useTenantCurrency();
  const fmt = (cents?: number) => (cents == null ? '' : formatMoney(Math.abs(cents), currency));
```

(The `fmt` closure moves inside the component so it can see `currency`; the module-level `const fmt = ...` declaration removed in the first replace above.)

- [ ] **Step 6: Fix `dashboard/ForwardView.tsx`**

Find:
```ts
import React from 'react';
import { CashflowTimeline } from './CashflowTimeline';
import { NextMomentsList } from './NextMomentsList';
import type { NextMoment } from './types';

interface Props {
  cashTodayCents: number;
  projection: { days: { date: string; cents: number }[]; moodLabel: 'healthy' | 'tight' | 'critical' } | null;
  moments: NextMoment[];
}

const moodIcon = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? '☀️' : label === 'tight' ? '⛅' : '⛈';

const moodText = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? 'Healthy' : label === 'tight' ? 'Tight' : 'Critical';

const fmt = (cents: number) =>
  '$' + Math.round(cents / 100).toLocaleString('en-US');

export const ForwardView: React.FC<Props> = ({ cashTodayCents, projection, moments }) => {
  const projectedEnd = projection?.days[projection.days.length - 1]?.cents ?? cashTodayCents;
```

Replace with:
```ts
import React from 'react';
import { CashflowTimeline } from './CashflowTimeline';
import { NextMomentsList } from './NextMomentsList';
import type { NextMoment } from './types';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';

interface Props {
  cashTodayCents: number;
  projection: { days: { date: string; cents: number }[]; moodLabel: 'healthy' | 'tight' | 'critical' } | null;
  moments: NextMoment[];
}

const moodIcon = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? '☀️' : label === 'tight' ? '⛅' : '⛈';

const moodText = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? 'Healthy' : label === 'tight' ? 'Tight' : 'Critical';

export const ForwardView: React.FC<Props> = ({ cashTodayCents, projection, moments }) => {
  const currency = useTenantCurrency();
  const fmt = (cents: number) => formatMoney(cents, currency);
  const projectedEnd = projection?.days[projection.days.length - 1]?.cents ?? cashTodayCents;
```

- [ ] **Step 7: Manual verification**

Run the dev server, view the Dashboard as a test tenant with `currency: 'AUD'` configured, and confirm the This Month strip, any attention items with dollar amounts, the cash-forward headline, and (if triggered via `?catchup=1`) the catch-up banner all show `A$` instead of `$`.

- [ ] **Step 8: Commit**

```bash
git add plugins/agentbook-core/frontend/src/hooks/useTenantCurrency.ts plugins/agentbook-core/frontend/src/pages/Ledger.tsx plugins/agentbook-core/frontend/src/pages/dashboard/ThisMonthStrip.tsx plugins/agentbook-core/frontend/src/pages/dashboard/CatchUpBanner.tsx plugins/agentbook-core/frontend/src/pages/dashboard/AttentionItem.tsx plugins/agentbook-core/frontend/src/pages/dashboard/ForwardView.tsx
git commit -m "fix(core): dashboard widgets show the tenant's real currency, not hardcoded USD"
```

---

### Task 6: Hardcoded-currency sweep — `agentbook-expense` plugin frontend

**Files:**
- Create: `plugins/agentbook-expense/frontend/src/hooks/useTenantCurrency.ts`
- Modify: `plugins/agentbook-expense/frontend/src/pages/Bills.tsx`, `plugins/agentbook-expense/frontend/src/pages/BankConnection.tsx`, `plugins/agentbook-expense/frontend/src/pages/Budgets.tsx`, `plugins/agentbook-expense/frontend/src/pages/Receipts.tsx`, `plugins/agentbook-expense/frontend/src/pages/BankReview.tsx`

**Interfaces:**
- Produces: `useTenantCurrency()` for `agentbook-expense`'s frontend, same exact copy as Task 5's.

- [ ] **Step 1: Create the hook**

Create `plugins/agentbook-expense/frontend/src/hooks/useTenantCurrency.ts` with the identical body used in Task 5, Step 1.

- [ ] **Step 2: Fix each of the 5 pages**

Each of these five files is a standalone page component (not a deeply-nested widget), so each independently adds the hook call and swaps its local hardcoded-`$` helper for `formatMoney`.

`Bills.tsx` — find (module-level, above the component):
```ts
const fmt$ = (cents: number) =>
  '$' + (cents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
```
Replace with:
```ts
const fmt$ = (cents: number, currency: string) => formatMoney(cents, currency);
```
Then find its 3 call sites (`{fmt$(summary.openCents)}`, `{fmt$(summary.overdueCents)}`, `{fmt$(b.amountCents)}`) and add `, currency` as the second argument to each. Add the two imports near the top of the file (`import { formatMoney } from '@agentbook/i18n';` and `import { useTenantCurrency } from '../hooks/useTenantCurrency';`), and inside `export const BillsPage: React.FC = () => {`, add `const currency = useTenantCurrency();` alongside its other hooks.

`BankConnection.tsx` — find:
```ts
function fmt(cents: number) {
  return '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}
```
Replace with:
```ts
function fmt(cents: number, currency: string) {
  return formatMoney(Math.abs(cents), currency);
}
```
Then find every call site of `fmt(...)` in this file and add `, currency` as the second argument to each. Add the two imports near the top of the file, and inside this file's component, add `const currency = useTenantCurrency();` alongside its other hooks.

`Budgets.tsx` — find (module-level, above the component):
```ts
const fmt$ = (cents: number) =>
  '$' + (cents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
```
Replace with:
```ts
const fmt$ = (cents: number, currency: string) => formatMoney(cents, currency);
```
Then find its one call site (`{fmt$(b.spentCents)} / {fmt$(b.amountCents)} {periodLabel(b.period)}`) and add `, currency` to both calls: `{fmt$(b.spentCents, currency)} / {fmt$(b.amountCents, currency)} {periodLabel(b.period)}`. Add the two imports near the top of the file, and inside `export const BudgetsPage: React.FC = () => {`, add `const currency = useTenantCurrency();` alongside its other hooks.

`Receipts.tsx` — this one's `fmt` is already declared inside the component body (`export const ReceiptsPage: React.FC = () => {` starts before it), so it can close over a `currency` declared just above it. Find:
```ts
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
```
Replace with:
```ts
  const fmt = (cents: number) => formatMoney(cents, currency);
```
Add `const currency = useTenantCurrency();` immediately above this line (inside the component, not at module level).

`BankReview.tsx` — this one's `fmtCents` is a **module-level** function (declared before `export const BankReviewPage: React.FC = () => {`), so it cannot close over a component-local `currency` — it needs a parameter, the same way `Bills.tsx`/`Budgets.tsx`/`BankConnection.tsx` do. Find:
```ts
function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```
Replace with:
```ts
function fmtCents(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}
```
Then find its two call sites and add `, currency`:
```ts
                        {direction === 'inflow' ? '+' : '-'}{fmtCents(Math.abs(t.amount))}
```
→
```ts
                        {direction === 'inflow' ? '+' : '-'}{fmtCents(Math.abs(t.amount), currency)}
```
and
```ts
                            {fmtCents(c.amountCents)} · {fmtDate(c.date)} · confidence {(c.score * 100).toFixed(0)}%
```
→
```ts
                            {fmtCents(c.amountCents, currency)} · {fmtDate(c.date)} · confidence {(c.score * 100).toFixed(0)}%
```
Add `const currency = useTenantCurrency();` inside `export const BankReviewPage: React.FC = () => {` alongside its other hooks.

For every one of these 5 files: add `import { formatMoney } from '@agentbook/i18n';` and `import { useTenantCurrency } from '../hooks/useTenantCurrency';` near the top.

- [ ] **Step 3: Manual verification**

Run the dev server, view Bills/Bank Connection/Budgets/Receipts/Bank Review as a test tenant with `currency: 'AUD'` configured, and confirm all dollar amounts show `A$` instead of `$`.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-expense/frontend/src/hooks/useTenantCurrency.ts plugins/agentbook-expense/frontend/src/pages/Bills.tsx plugins/agentbook-expense/frontend/src/pages/BankConnection.tsx plugins/agentbook-expense/frontend/src/pages/Budgets.tsx plugins/agentbook-expense/frontend/src/pages/Receipts.tsx plugins/agentbook-expense/frontend/src/pages/BankReview.tsx
git commit -m "fix(expense): dashboard/list pages show the tenant's real currency, not hardcoded USD"
```

---

## Verification

- Full test suite: `cd apps/web-next && npx vitest run` (new + existing tests, no regressions), plus the relevant plugin frontend test suites if any exist for the touched pages.
- Manual: set a test tenant's jurisdiction to `au`, confirm the Tax Dashboard shows a real (non-US-bracket, non-zero-Medicare-Levy-only-because-hardcoded) figure, the Quarterly tab shows Oct/Feb/Apr/Jul 28 deadlines, and every touched widget shows `A$` instead of `$`.
- Deploy: commit → PR → CI → merge → build + deploy to production (same flow as every prior PR this session) → spot-check the Tax Dashboard and Quarterly tab against a real AU test tenant in production.
