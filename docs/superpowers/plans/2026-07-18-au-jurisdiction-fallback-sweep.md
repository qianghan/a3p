# AU Jurisdiction-Fallback Sweep (Roadmap PR AU-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining "AU tenant silently gets US/CA-shaped behavior" sites named by the roadmap: the per-diem route, the morning-digest tax-deadline countdown, and the year-end tax-package PDF/CSV export — each either honestly declines AU (where no real AU data exists) or serves real, already-published AU jurisdiction-pack data (where it does).

**Architecture:** This is 3 independent fixes across 3 areas, each reusing data/patterns that already exist elsewhere in the codebase:
1. **Per-diem** has no AU counterpart in `packages/agentbook-jurisdictions` (AU doesn't have a GSA-style per-diem construct) — the fix is an honest 422 "not supported" response, mirroring the CA short-circuit already in this exact route.
2. **Tax-deadline countdown** (`agentbook-digest-tips.ts` + `morning-digest/route.ts`) currently hardcodes two `Date[]` arrays (`usDeadlines`/`caDeadlines`) instead of reading the real, already-published `usCalendarDeadlines`/`caCalendarDeadlines`/`auCalendarDeadlines` providers from `@agentbook/jurisdictions` (the exact mechanism already used by `apps/web-next/src/app/api/v1/agentbook/cron/calendar-check/route.ts`'s `PACKS` map). Confirmed the hardcoded US/CA dates already match what the real pack data produces — this is pure wiring, not new business logic.
3. **Tax-package export** (`agentbook-tax-package.ts` + `agentbook-tax-pdf.ts` + the `tax-package/generate` route) hardcodes `jurisdiction: 'us' | 'ca'` throughout and defaults anything non-CA to "IRS Schedule C" — widened to `'au'`, with a real AU tax-line fallback mapping using the exact `taxCategory` label vocabulary already seeded by `packages/agentbook-jurisdictions/src/au/chart-of-accounts.ts` (e.g. `'ITR - Motor vehicle expenses'`), and a real AU form name.

**Investigation already confirmed no further work is needed in** `apps/web-next/src/lib/agentbook-bot-agent.ts` (the Telegram bot) — a full-file audit found exactly 3 jurisdiction-binary blocks: `mileage.record` (already fixed by a merged PR), and `tax.generate_package`/`per_diem.record` (both call through to the exact routes/functions this plan fixes directly — fixing the underlying route/library function fixes the bot's behavior too, since the bot just forwards to `generatePackage`/calls the per-diem logic path; no bot-agent.ts edit is needed).

**Tech Stack:** TypeScript, Next.js API routes, Vitest.

## Global Constraints

- **Reuse before rewrite.** No new AU business logic is invented. Per-diem gets an honest decline (matching the CA precedent in the same file). The deadline countdown reads real, already-published `@agentbook/jurisdictions` calendar data. The tax-package AU tax-line labels reuse the exact vocabulary already seeded in `au/chart-of-accounts.ts` — not new terminology.
- **`fmtUsd`'s hardcoded USD formatting inside `agentbook-digest-tips.ts` is explicitly OUT OF SCOPE for this PR.** It affects every non-US tenant (including CA, which already passed its own Gate without this being flagged), not something AU-specific — it's a general product-wide currency-display gap, not an "AU jurisdiction-fallback" bug. Do not touch it here.
- **`bot-agent.ts`'s `tax.generate_package` and `per_diem.record` jurisdiction ternaries are also explicitly OUT OF SCOPE** (confirmed in an earlier PR's review) — they call into the functions this plan fixes at the source, so no direct edit to `bot-agent.ts` is needed or wanted.
- **No schema changes.** No new columns, no new interfaces beyond widening existing union types.

---

### Task 1: Per-diem route — honest AU decline

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-expense/per-diem/route.ts`
- Test: locate the existing test file for this route first (`find apps/web-next/src -ipath "*per-diem*" -path "*test*"`); if none exists, create `apps/web-next/src/app/api/v1/agentbook-expense/per-diem/__tests__/route.test.ts` following the mocking pattern in `apps/web-next/src/app/api/v1/agentbook-expense/mileage/__tests__/au-jurisdiction.test.ts` (mock `@naap/database`'s `prisma`, `@/lib/agentbook-tenant`'s `safeResolveAgentbookTenant`).

**Interfaces:**
- No exported signatures change — this is an internal branch-widening inside the route handler.

- [ ] **Step 1: Write the failing test**

Add this test (creating the file if none exists, using the exact mocking pattern from the sibling AU mileage test):

```typescript
it('an AU tenant gets an honest 422 "not supported" response, not silent US per-diem rates', async () => {
  tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
  const req = new NextRequest('http://x/per-diem', {
    method: 'POST',
    body: JSON.stringify({ startDate: '2026-01-01', days: 2 }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(res.status).toBe(422);
  expect(body.success).toBe(false);
  expect(body.code).toBe('unsupported_jurisdiction');
  expect(body.error).toMatch(/AU/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-next && npx vitest run <the per-diem test file path>`
Expected: FAIL — today an AU tenant falls through the `jurisdiction === 'ca'` check (since `const jurisdiction: 'us' | 'ca' = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';` coerces `'au'` to `'us'`) and gets a 201 with US GSA per-diem rates, not a 422.

- [ ] **Step 3: Implement**

In `apps/web-next/src/app/api/v1/agentbook-expense/per-diem/route.ts`, change:

```typescript
    const jurisdiction: 'us' | 'ca' = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    if (jurisdiction === 'ca') {
      return NextResponse.json(
        {
          success: false,
          error: "Per-diem isn't a CA-supported method yet — use mileage + meals expenses instead. (Coming in a future release.)",
          code: 'unsupported_jurisdiction',
        },
        { status: 422 },
      );
    }
```

to:

```typescript
    const jurisdiction = cfg?.jurisdiction || 'us';
    if (jurisdiction === 'ca' || jurisdiction === 'au') {
      const label = jurisdiction === 'ca' ? 'CA' : 'AU';
      return NextResponse.json(
        {
          success: false,
          error: `Per-diem isn't a ${label}-supported method yet — use mileage + meals expenses instead. (Coming in a future release.)`,
          code: 'unsupported_jurisdiction',
        },
        { status: 422 },
      );
    }
```

(The local `jurisdiction` variable's type is now inferred as `string` rather than a narrow union — that's fine here since it's only ever compared with `===`, never passed to a function expecting the narrower type. If TypeScript complains about a downstream use of `jurisdiction` expecting `'us' | 'ca'`, check the rest of the function — the only other use should be constructing the `AbExpense.jurisdiction` string field, which is a free-text column and accepts any string.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-next && npx vitest run <the per-diem test file path>`
Expected: PASS. Also run the full file to confirm the pre-existing CA test (if one exists) and the happy-path US test still pass unmodified.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-expense/per-diem/route.ts <test file path>
git commit -m "fix(per-diem): AU tenants get an honest 'not supported' response, not silent US rates"
```

---

### Task 2: Wire real jurisdiction-pack calendar data into the tax-deadline countdown

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-digest-tips.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts`
- Test: `apps/web-next/src/lib/agentbook-digest-tips.test.ts` if it exists (`find apps/web-next/src -ipath "*digest-tips*test*"` first); create if absent, following the mocking pattern from `apps/web-next/src/lib/agentbook-tax-package.test.ts` (mock `@naap/database`).

**Interfaces:**
- Produces: a new exported function from `agentbook-digest-tips.ts`:
  ```typescript
  export function nextQuarterlyTaxDeadline(
    jurisdiction: string,
    region: string,
    now: Date,
  ): number | null // days until the next quarterly estimated-payment deadline, or null if none upcoming
  ```
  Both `agentbook-digest-tips.ts`'s own internal `buildTipContext` and `morning-digest/route.ts` call this instead of maintaining separate copies of the hardcoded `usDeadlines`/`caDeadlines` arrays — this eliminates the exact duplication the roadmap flagged ("near-identical copy" in both files).

- [ ] **Step 1: Write the failing tests**

Create/extend `apps/web-next/src/lib/agentbook-digest-tips.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { nextQuarterlyTaxDeadline } from './agentbook-digest-tips';

describe('nextQuarterlyTaxDeadline', () => {
  it('US: returns days until the next IRS quarterly-estimate deadline (Apr 15 / Jun 15 / Sep 15 / Jan 15)', () => {
    const now = new Date(Date.UTC(2026, 2, 20)); // Mar 20, 2026 — before Apr 15
    const days = nextQuarterlyTaxDeadline('us', '', now);
    const expectedDate = new Date(Date.UTC(2026, 3, 15));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
  });

  it('CA: returns days until the next CRA quarterly-instalment deadline (15th of Mar/Jun/Sep/Dec)', () => {
    const now = new Date(Date.UTC(2026, 4, 1)); // May 1, 2026 — before Jun 15
    const days = nextQuarterlyTaxDeadline('ca', '', now);
    const expectedDate = new Date(Date.UTC(2026, 5, 15));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
  });

  it('AU: returns days until the next PAYG instalment deadline (Oct 28 / Feb 28 / Apr 28 / Jul 28) — NOT a US/CA date', () => {
    const now = new Date(Date.UTC(2026, 8, 1)); // Sep 1, 2026 — before Oct 28
    const days = nextQuarterlyTaxDeadline('au', '', now);
    const expectedDate = new Date(Date.UTC(2026, 9, 28));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
    // Explicitly prove this is NOT the old bug's US fallback date (Sep 15 already passed, so the
    // old broken code would have picked Jan 15 next year — a very different, wrong number).
    const wrongUsFallbackDays = Math.round(
      (new Date(Date.UTC(2027, 0, 15)).getTime() - now.getTime()) / 86_400_000,
    );
    expect(days).not.toBe(wrongUsFallbackDays);
  });

  it('returns null when no known jurisdiction/region has any upcoming quarterly deadline in the lookup window (defensive edge case, not expected in practice)', () => {
    // Every real jurisdiction pack always has an upcoming deadline within a year,
    // so this just confirms the function doesn't throw for an unrecognized jurisdiction —
    // it should fall back to the 'us' pack's deadlines (same fallback as every other
    // jurisdiction-pack consumer in this codebase, e.g. `BRACKET_PROVIDERS[j] ?? usTaxBrackets`).
    const now = new Date(Date.UTC(2026, 2, 20));
    const days = nextQuarterlyTaxDeadline('zz', '', now);
    expect(days).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-digest-tips.test.ts`
Expected: FAIL — `nextQuarterlyTaxDeadline` doesn't exist yet.

- [ ] **Step 3: Implement — `agentbook-digest-tips.ts`**

Add the import (alongside the existing `import { prisma as db } from '@naap/database';` at the top):

```typescript
import { usPack, caPack, auPack, ukPack, type JurisdictionPack } from '@agentbook/jurisdictions';

const CALENDAR_PACKS: Record<string, JurisdictionPack> = { us: usPack, ca: caPack, au: auPack, uk: ukPack };

/**
 * Days until the next quarterly estimated-tax/instalment deadline, read
 * from the real jurisdiction-pack calendar data (not a hardcoded date
 * array) — each jurisdiction's own pack already contains the correct
 * quarterly cadence (US: `..._estimated_tax_due`, CA: `..._instalment_due`,
 * AU: `payg_..._instalment`). Filtering by titleKey substring instead of a
 * shared `recurrence` tag, since the packs don't tag these consistently
 * (some are 'annual', some 'quarterly') but the titleKey naming is
 * consistent across every pack that has this concept.
 */
export function nextQuarterlyTaxDeadline(
  jurisdiction: string,
  region: string,
  now: Date,
): number | null {
  const pack = CALENDAR_PACKS[jurisdiction] ?? CALENDAR_PACKS.us;
  const year = now.getUTCFullYear();
  const candidates = [
    ...pack.calendarDeadlines.getDeadlines(year, region),
    ...pack.calendarDeadlines.getDeadlines(year + 1, region),
  ].filter((d) => /instalment|estimated_tax/i.test(d.titleKey));

  let closest: Date | null = null;
  for (const c of candidates) {
    const d = new Date(`${c.date}T00:00:00.000Z`);
    if (d > now && (!closest || d < closest)) closest = d;
  }
  return closest ? Math.round((closest.getTime() - now.getTime()) / 86_400_000) : null;
}
```

Then replace the existing inline block:

```typescript
  // Tax deadline countdown
  const jurisdiction = tenantConfig?.jurisdiction || 'us';
  const usDeadlines = [
    new Date(now.getFullYear(), 3, 15), new Date(now.getFullYear(), 5, 15),
    new Date(now.getFullYear(), 8, 15), new Date(now.getFullYear() + 1, 0, 15),
  ];
  const caDeadlines = [
    new Date(now.getFullYear(), 2, 15), new Date(now.getFullYear(), 5, 15),
    new Date(now.getFullYear(), 8, 15), new Date(now.getFullYear(), 11, 15),
  ];
  const deadlines = jurisdiction === 'ca' ? caDeadlines : usDeadlines;
  const next = deadlines.find((d) => d > now);
  const taxDaysUntilQ = next ? Math.round((next.getTime() - now.getTime()) / 86_400_000) : null;
```

with:

```typescript
  // Tax deadline countdown — reads real per-jurisdiction quarterly
  // deadline data instead of a hardcoded US/CA-only date array.
  const jurisdiction = tenantConfig?.jurisdiction || 'us';
  const taxDaysUntilQ = nextQuarterlyTaxDeadline(jurisdiction, tenantConfig?.region || '', now);
```

(Leave every other line in this function — including the surrounding `outstandingInvoices`/`recurringRules` blocks — untouched; only this one block changes.)

- [ ] **Step 4: Implement — `morning-digest/route.ts`**

Add the same import:

```typescript
import { nextQuarterlyTaxDeadline } from '@/lib/agentbook-digest-tips';
```

(This adds to the existing `import { buildTipContext, generateTaxTip, generateCashFlowTip } from '@/lib/agentbook-digest-tips';` line — combine into one import statement rather than two separate ones.)

Replace:

```typescript
  // Tax-deadline countdown (US: Apr 15 / Jun 15 / Sep 15 / Jan 15; CA: 15th of Mar/Jun/Sep/Dec)
  const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const jurisdiction = tenantConfig?.jurisdiction || 'us';
  const usDeadlines = [
    new Date(now.getFullYear(), 3, 15), new Date(now.getFullYear(), 5, 15),
    new Date(now.getFullYear(), 8, 15), new Date(now.getFullYear() + 1, 0, 15),
  ];
  const caDeadlines = [
    new Date(now.getFullYear(), 2, 15), new Date(now.getFullYear(), 5, 15),
    new Date(now.getFullYear(), 8, 15), new Date(now.getFullYear(), 11, 15),
  ];
  const deadlines = jurisdiction === 'ca' ? caDeadlines : usDeadlines;
  const nextDeadline = deadlines.find((d) => d > now);
  const taxDaysUntilQ = nextDeadline
    ? Math.round((nextDeadline.getTime() - now.getTime()) / 86_400_000)
    : null;
```

with:

```typescript
  // Tax-deadline countdown — reads real per-jurisdiction quarterly
  // deadline data instead of a hardcoded US/CA-only date array.
  const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const jurisdiction = tenantConfig?.jurisdiction || 'us';
  const taxDaysUntilQ = nextQuarterlyTaxDeadline(jurisdiction, tenantConfig?.region || '', now);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-digest-tips.test.ts`
Expected: PASS, all 4 new tests.

- [ ] **Step 6: Run the broader regression check**

Run: `find apps/web-next/src -ipath "*digest*" -path "*test*"` to locate every existing test file touching `agentbook-digest-tips.ts` or the morning-digest route, then run all of them together, e.g.:
`cd apps/web-next && npx vitest run src/lib/agentbook-digest-tips.test.ts <any other digest/morning-digest test files found> 2>&1 | tail -15`
Expected: PASS — confirms `buildTipContext`'s other fields (`cashTodayCents`, `outstandingInvoiceCents`, etc.) and `generateTaxTip`'s consumption of `ctx.taxDaysUntilQ` are unaffected; only the *source* of `taxDaysUntilQ` changed, not its shape or the values for US/CA (confirm this explicitly: the US/CA numbers should be unchanged since the pack data was confirmed to match the old hardcoded dates exactly).

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/lib/agentbook-digest-tips.ts \
        apps/web-next/src/lib/agentbook-digest-tips.test.ts \
        apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts
git commit -m "fix(digest): wire real per-jurisdiction quarterly tax deadlines, closing the AU gap"
```

---

### Task 3: AU-aware tax-package export (PDF/CSV labels + form name)

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-tax-package.ts`
- Modify: `apps/web-next/src/lib/agentbook-tax-pdf.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/tax-package/generate/route.ts`
- Test: `apps/web-next/src/lib/agentbook-tax-package.test.ts` (extend the existing file)

**Interfaces:**
- `PackageInput.jurisdiction` and `PackageData.jurisdiction` widen from `'us' | 'ca'` to `'us' | 'ca' | 'au'`.
- `taxLineFor(jurisdiction: 'us' | 'ca' | 'au', accountType, name, taxCategory): string` — signature widens; new `'au'` branch added.
- No new exports beyond the widened types.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-next/src/lib/agentbook-tax-package.test.ts`, inside (or near) the existing `describe('taxLineFor (jurisdiction-aware mapper)', ...)` block:

```typescript
it('AU: an explicit taxCategory always wins, regardless of jurisdiction branch (unchanged behavior, sanity check)', () => {
  const line = taxLineFor('au', 'expense', 'Anything', 'ITR - Motor vehicle expenses');
  expect(line).toBe('ITR - Motor vehicle expenses');
});

it('AU: falls back to real ATO ITR category labels (not Schedule C) when no explicit taxCategory is set', () => {
  expect(taxLineFor('au', 'expense', 'Motor Vehicle Expenses', null)).toBe('ITR - Motor vehicle expenses');
  expect(taxLineFor('au', 'expense', 'Rent', null)).toBe('ITR - Rent expenses');
  expect(taxLineFor('au', 'expense', 'Wages & Salaries', null)).toBe('ITR - Salary and wage expenses');
  expect(taxLineFor('au', 'expense', '__totally_unknown__', null)).toBe('ITR - All other expenses');
});

it('AU: non-expense account types get an ITR-labeled catch-all, not a Schedule-C or T2125 label', () => {
  const line = taxLineFor('au', 'revenue', 'Sales Revenue', null);
  expect(line).toMatch(/ITR/);
  expect(line).not.toMatch(/Schedule C|T2125/);
});
```

Also add a new describe block for `gatherPackageData` with an AU tenant, mirroring the existing `'emits T2125-style box keys when jurisdiction = ca'` test:

```typescript
it('emits real ATO ITR-style category keys when jurisdiction = au (not Schedule C)', async () => {
  mockedDb.abTenantConfig.findUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD' });
  // Reuse whatever abAccount/abExpense mock setup the existing 'ca' test above uses,
  // adjusted for an AU-labeled expense account (e.g. name 'Motor Vehicle Expenses',
  // taxCategory 'ITR - Motor vehicle expenses', matching the real au/chart-of-accounts.ts seed).
  const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'au' });
  const keys = Object.keys(data.pnlByLine);
  expect(keys.some((k) => k.includes('ITR'))).toBe(true);
  expect(keys.some((k) => k.includes('Schedule C') || k.includes('T2125'))).toBe(false);
});
```

(Read the existing CA test's exact `abAccount.findMany`/`abExpense.findMany` mock setup first and mirror its shape precisely — the plan can't predict the exact mock data shape without seeing the surrounding test file's helper functions, so match the established pattern rather than inventing a new one.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-tax-package.test.ts`
Expected: FAIL (and likely a TypeScript compile error, since `'au'` isn't yet a valid value for the `jurisdiction` parameter type) — confirms the widening is genuinely required, not just the branch logic.

- [ ] **Step 3: Implement — `agentbook-tax-package.ts`**

1. Widen both type declarations:

```typescript
export interface PackageInput {
  tenantId: string;
  year: number;
  jurisdiction: 'us' | 'ca';
}
```
→
```typescript
export interface PackageInput {
  tenantId: string;
  year: number;
  jurisdiction: 'us' | 'ca' | 'au';
}
```

(Apply the identical change to `PackageData.jurisdiction`, the second `'us' | 'ca'` occurrence found via `grep -n "jurisdiction: 'us' | 'ca'"` in this file.)

2. Widen `taxLineFor`'s signature and add the AU branch — change:

```typescript
export function taxLineFor(
  jurisdiction: 'us' | 'ca',
  accountType: string | null,
  name: string,
  taxCategory: string | null,
): string {
  if (taxCategory && taxCategory.trim()) return taxCategory.trim();

  if (accountType && accountType !== 'expense') {
    return jurisdiction === 'ca' ? 'T2125 — Other (non-expense)' : 'Schedule C — Other (non-expense)';
  }

  const n = (name || '').toLowerCase();

  if (jurisdiction === 'ca') {
```

to:

```typescript
export function taxLineFor(
  jurisdiction: 'us' | 'ca' | 'au',
  accountType: string | null,
  name: string,
  taxCategory: string | null,
): string {
  if (taxCategory && taxCategory.trim()) return taxCategory.trim();

  if (accountType && accountType !== 'expense') {
    if (jurisdiction === 'au') return 'ITR — Other (non-expense)';
    return jurisdiction === 'ca' ? 'T2125 — Other (non-expense)' : 'Schedule C — Other (non-expense)';
  }

  const n = (name || '').toLowerCase();

  if (jurisdiction === 'au') {
    // Real ATO ITR business-schedule category labels, matching the exact
    // vocabulary already seeded by packages/agentbook-jurisdictions/src/au/chart-of-accounts.ts —
    // not new terminology. Accounts seeded from that chart already carry an
    // explicit taxCategory (handled by the short-circuit above); this
    // name-based fallback only matters for custom/manually-created accounts.
    if (/fuel|car|truck|vehicle|mileage|auto/.test(n)) return 'ITR - Motor vehicle expenses';
    if (/travel/.test(n)) return 'ITR - Travel expenses';
    if (/rent/.test(n)) return 'ITR - Rent expenses';
    if (/repair|maintenance/.test(n)) return 'ITR - Repairs and maintenance';
    if (/interest/.test(n)) return 'ITR - Interest expenses';
    if (/depreciation/.test(n)) return 'ITR - Depreciation expenses';
    if (/salary|wage|payroll/.test(n)) return 'ITR - Salary and wage expenses';
    if (/superannuation|super\b/.test(n)) return 'ITR - Superannuation expenses';
    if (/contractor/.test(n)) return 'ITR - Contractor expenses';
    if (/home.?office/.test(n)) return 'ITR - Home office expenses';
    return 'ITR - All other expenses';
  }

  if (jurisdiction === 'ca') {
```

- [ ] **Step 4: Implement — `agentbook-tax-pdf.ts`**

Change:

```typescript
  const formName = data.jurisdiction === 'ca' ? 'CRA T2125' : 'IRS Schedule C';
```

to:

```typescript
  const formName =
    data.jurisdiction === 'au' ? 'ATO Individual Tax Return (Business Schedule)'
    : data.jurisdiction === 'ca' ? 'CRA T2125'
    : 'IRS Schedule C';
```

And change the mileage-unit fallback:

```typescript
          `${data.mileage.totalUnit.toFixed(2)} ${data.mileage.entries[0]?.unit ?? (data.jurisdiction === 'ca' ? 'km' : 'mi')}`,
```

to:

```typescript
          `${data.mileage.totalUnit.toFixed(2)} ${data.mileage.entries[0]?.unit ?? (data.jurisdiction === 'ca' || data.jurisdiction === 'au' ? 'km' : 'mi')}`,
```

- [ ] **Step 5: Implement — `tax-package/generate/route.ts`**

Change:

```typescript
interface GenerateBody {
  year?: number | string;
  jurisdiction?: 'us' | 'ca';
}
```

to:

```typescript
interface GenerateBody {
  year?: number | string;
  jurisdiction?: 'us' | 'ca' | 'au';
}
```

And change:

```typescript
    let jurisdiction: 'us' | 'ca' = body.jurisdiction === 'ca' ? 'ca' : 'us';
    if (!body.jurisdiction) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    }
```

to:

```typescript
    let jurisdiction: 'us' | 'ca' | 'au' =
      body.jurisdiction === 'ca' || body.jurisdiction === 'au' ? body.jurisdiction : 'us';
    if (!body.jurisdiction) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' || cfg?.jurisdiction === 'au' ? cfg.jurisdiction : 'us';
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-tax-package.test.ts`
Expected: PASS, all tests including the new AU ones and every pre-existing US/CA test unchanged.

- [ ] **Step 7: Run the full affected-file regression check**

Run: `find apps/web-next/src -ipath "*tax-package*test*" -o -ipath "*tax-pdf*test*" -o -ipath "*tax-csv*test*"` to find every test file touching these three modules, then run them all together:
`cd apps/web-next && npx vitest run <every file found> 2>&1 | tail -20`
Expected: PASS — the CSV serializer (`agentbook-tax-csv.ts`) consumes `PackageData` but wasn't modified; confirm it still handles an AU-jurisdiction `PackageData` object without error (it should, since CSV serialization is generic over `pnlByLine`'s string keys regardless of jurisdiction).

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/lib/agentbook-tax-package.ts \
        apps/web-next/src/lib/agentbook-tax-package.test.ts \
        apps/web-next/src/lib/agentbook-tax-pdf.ts \
        apps/web-next/src/app/api/v1/agentbook-tax/tax-package/generate/route.ts
git commit -m "feat(tax-package): AU tenants get real ATO ITR labels and form name, not IRS Schedule C"
```
