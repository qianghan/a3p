# Launch-gap PR-6: GST/Sales-Tax on Invoices (AU/CA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invoices for AU and CA tenants currently never compute sales tax — the AU GST engine (10% flat) and CA's province-aware GST/HST/PST engine exist in `packages/agentbook-jurisdictions` but are never called from any invoice-creation code path, and `AbInvoice` has no column to store a tax amount at all. This plan adds `taxRate`/`taxCents` to `AbInvoice`, wires tax computation into every production invoice-creation path (the plain create route, the shared chat/NL draft helper, and the recurring-invoice cron), posts a correct multi-line journal entry (crediting a GST/HST/PST Payable liability account, not just Revenue), records per-component rows in the already-existing but currently-dead `AbSalesTaxCollected` table, and adds an editable tax-rate field to the invoice-creation UI.

**Architecture:** A single new shared helper (`computeInvoiceTax`) is the one place that knows how to turn `(tenantId, subtotalCents)` into a tax result — every write path calls it once and applies the result identically (grand-total `amountCents`, `taxRate`, `taxCents`, journal lines, `AbSalesTaxCollected` rows). This mirrors the "wired twice, not built once" fix pattern already used earlier in this roadmap (PR-1's tax engine, PR-2's chart of accounts): one correct implementation, reused everywhere, instead of each call site reinventing it.

**Tech Stack:** Prisma 5.20 (Postgres), Next.js Route Handlers (the only routes verified to reach production — see Global Constraints), Vite/React for the invoice-creation frontend, Vitest for all tests.

## Global Constraints

- **Production-file discipline (the exact lesson from Launch-gap PR-5):** every write path this plan touches must be verified as one that `apps/web-next` actually serves in production. Confirmed production paths, and ONLY these are in scope for behavior changes:
  - `apps/web-next/src/app/api/v1/agentbook-invoice/invoices/route.ts` (`POST`)
  - `apps/web-next/src/lib/agentbook-invoice-draft.ts` (`createInvoiceDraft`, shared by 4 call sites: `draft-from-text`, `from-time-entries`, `estimates/[id]/convert`, and the bot-agent's `invoice.create_from_chat` step)
  - `apps/web-next/src/app/api/v1/agentbook/cron/recurring-invoices/route.ts`
  - `plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx` (Vite-bundled plugin frontend, served via the CDN path, genuinely reaches production)
  - `plugins/agentbook-invoice/backend/src/server.ts` (the Express plugin backend) is **local-dev-only** (confirmed: only ever started manually via `npx tsx .../server.ts` per CLAUDE.md's Quick Start; never deployed to Vercel) and is **explicitly out of scope** for this plan — it will silently diverge from production behavior, which is an accepted, named tradeoff (see "Out of scope" below), not an oversight.
- Scope boundary (from the roadmap): correct invoice math only — default the tax rate from the tenant's jurisdiction, keep it editable, compute `taxCents` correctly. No BAS/GST-return filing UI, no reporting UI.
- Every schema change needs a hand-written migration under `packages/database/prisma/migrations/`, following the existing convention (comment header explaining the change; this one is purely additive so no pre-flight dedup is needed, unlike PR-5's unique-constraint migration).
- Verify schema changes against an isolated, throwaway Postgres container (`docker run --rm -d -p <port>:5432 -e POSTGRES_PASSWORD=postgres --name <name> postgres:16`) bootstrapped via `prisma db push --skip-generate --accept-data-loss` (this repo has no baseline migration — `prisma migrate deploy` cannot bootstrap a virgin database; confirmed during Launch-gap PR-5). Never use the shared local dev DB.
- All new/changed backend code must preserve the existing `{ success: boolean, data?/error? }` JSON response shape used throughout `apps/web-next`'s agentbook routes.
- The two liability account codes this plan relies on (AU `2100` "GST Payable"; CA `2100` "GST/HST Payable" and `2200` "PST/QST Payable") already exist in `packages/agentbook-jurisdictions/src/{au,ca}/chart-of-accounts.ts` and are seeded into `AbAccount` by the existing, already-wired `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts` (confirmed live — called from `Onboarding.tsx`/`OnboardingChat.tsx` during tenant setup). This plan does not need to touch chart-of-accounts seeding at all.
- **Out of scope, explicitly named (not silently dropped):**
  - The Express dev-only `plugins/agentbook-invoice/backend/src/server.ts` duplicate routes — left un-synced.
  - US and UK sales tax — the roadmap names "AU and CA" specifically; for any other jurisdiction, `computeInvoiceTax` returns a zero-tax result (today's behavior, unchanged) rather than guessing.
  - Any BAS/GST-return filing or reporting UI that would consume the now-populated `AbSalesTaxCollected` table — that table already exists and already has a defined *read* consumer (`plugins/agentbook-tax/backend/src/tax-forms.ts`'s BAS aggregate), so populating it here is a data-layer completion of an already-designed feature, not new scope; building UI around it is not part of this plan.

---

### Task 1: Schema — `taxRate`/`taxCents` on `AbInvoice`

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (`model AbInvoice`)
- Create: `packages/database/prisma/migrations/20260717090000_add_invoice_tax_fields/migration.sql`

**Interfaces:**
- Produces: `AbInvoice.taxRate` (nullable Float, the combined tax rate applied, e.g. `0.10` for AU's flat 10% GST or `0.14975` for Quebec's GST+QST) and `AbInvoice.taxCents` (Int, default 0, the tax portion of `amountCents`). `amountCents` keeps its existing meaning — the full amount the client owes (tax-inclusive) — so every existing consumer (payment balance checks, aging reports, dashboards) is unaffected. `subtotalCents` is intentionally NOT added as a persisted column: `apps/web-next/src/lib/agentbook-invoice-pdf.ts` already expects to derive it as `inv.amountCents - (inv.taxCents ?? 0)` when a dedicated column isn't present (line 168), so this plan's two new columns alone make that existing (currently dead) fallback path live.

- [ ] **Step 1: Add the two fields to the Prisma schema**

In `packages/database/prisma/schema.prisma`, find `model AbInvoice` and its `amountCents` line:

```prisma
  amountCents         Int // amount in `currency` (tenant booking currency)
```

Add the two new fields directly after the `originalAmountCents`/`fxRate`/`fxRateSource`/`fxRateDate` block and before `issuedDate`, so the model reads:

```prisma
  amountCents         Int // amount in `currency` (tenant booking currency) — tax-inclusive grand total
  currency            String    @default("USD")
  originalCurrency    String?
  originalAmountCents Int?
  fxRate              Float?
  fxRateSource        String?
  fxRateDate          DateTime?
  // Sales tax (Launch-gap PR-6). taxRate is the combined rate applied at
  // creation time (e.g. 0.10 for AU GST, or a CA province's GST+PST/HST
  // sum) — null when no tax jurisdiction applies. taxCents is always the
  // tax portion of amountCents (0 when taxRate is null). subtotalCents is
  // intentionally not persisted — derive it as amountCents - taxCents;
  // agentbook-invoice-pdf.ts already expects exactly this fallback.
  taxRate             Float?
  taxCents            Int       @default(0)
  issuedDate          DateTime
```

- [ ] **Step 2: Write the migration**

Create `packages/database/prisma/migrations/20260717090000_add_invoice_tax_fields/migration.sql`:

```sql
-- Migration: AbInvoice.taxRate / AbInvoice.taxCents (Launch-gap PR-6, G-6A)
--
-- Purely additive — no pre-flight dedup needed (unlike PR-5's unique-
-- constraint migration). taxCents defaults to 0 so every existing invoice
-- row is unaffected (amountCents keeps meaning "grand total", now simply
-- with an implicit taxCents of 0 for pre-existing rows). taxRate is
-- nullable with no default, meaning "no tax jurisdiction applied" for all
-- existing rows.

ALTER TABLE "plugin_agentbook_invoice"."AbInvoice"
  ADD COLUMN IF NOT EXISTS "taxRate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "taxCents" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd packages/database && npx prisma generate`
Expected: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 4: Verify against an isolated throwaway Postgres**

```bash
docker run --rm -d -p 55492:5432 -e POSTGRES_PASSWORD=postgres --name pr6-verify-db postgres:16
sleep 3
DATABASE_URL="postgresql://postgres:postgres@localhost:55492/verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:55492/verify" \
  npx prisma db push --schema packages/database/prisma/schema.prisma --skip-generate --accept-data-loss
```
Expected: `Your database is now in sync with your Prisma schema.` Then confirm the columns exist:
```bash
docker exec -i pr6-verify-db psql -U postgres -d verify -c '\d plugin_agentbook_invoice."AbInvoice"' | grep -E 'taxRate|taxCents'
docker stop pr6-verify-db
```
Expected output includes both `taxRate` (double precision, nullable) and `taxCents` (integer, not null, default 0).

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260717090000_add_invoice_tax_fields
git commit -m "schema: add AbInvoice.taxRate/taxCents (Launch-gap PR-6)"
```

---

### Task 2: Shared `computeInvoiceTax` helper

**Files:**
- Create: `apps/web-next/src/lib/agentbook-invoice-tax.ts`
- Create: `apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts`

**Interfaces:**
- Consumes: `AbTenantConfig.jurisdiction`/`region` (existing fields); `auSalesTax`/`caSalesTax` from `@agentbook/jurisdictions/{au,ca}/sales-tax` (path mapping already exists in `tsconfig.base.json` — see Step 1).
- Produces: `computeInvoiceTax(tenantId: string, subtotalCents: number, overrideRate?: number | null): Promise<InvoiceTaxResult>`, `InvoiceTaxResult`, `InvoiceTaxComponent` — consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Import path is already confirmed — no tsconfig changes needed**

`tsconfig.base.json` already has the path mapping (confirmed by direct inspection, lines 58-59):
```
"@agentbook/jurisdictions": ["packages/agentbook-jurisdictions/src/index.ts"],
"@agentbook/jurisdictions/*": ["packages/agentbook-jurisdictions/src/*"]
```
So `import { auSalesTax } from '@agentbook/jurisdictions/au/sales-tax'` and `import { caSalesTax } from '@agentbook/jurisdictions/ca/sales-tax'` (exactly as written in Step 2 below) resolve correctly with zero tsconfig edits. Do not touch `tsconfig.base.json` for this task.

- [ ] **Step 2: Write the helper**

Create `apps/web-next/src/lib/agentbook-invoice-tax.ts`:

```ts
/**
 * Sales-tax computation for invoice creation (Launch-gap PR-6).
 *
 * Single source of truth: every invoice-creation write path (the plain
 * create route, the chat/NL draft helper, the recurring-invoice cron)
 * calls this once and applies the result identically. Scope is AU and CA
 * only, per the roadmap — every other jurisdiction returns a zero-tax
 * result (today's behavior, unchanged).
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { auSalesTax } from '@agentbook/jurisdictions/au/sales-tax';
import { caSalesTax } from '@agentbook/jurisdictions/ca/sales-tax';

export interface InvoiceTaxComponent {
  /** e.g. 'GST', 'HST', 'PST' — matches SalesTaxResult.components[].type. */
  type: string;
  rate: number;
  amountCents: number;
  /** AbAccount.code of the liability account this component credits. */
  accountCode: string;
}

export interface InvoiceTaxResult {
  /** Combined rate across all components (e.g. 0.14975 for Quebec). 0 when no tax applies. */
  taxRate: number;
  /** Sum of all components' amountCents. 0 when no tax applies. */
  taxCents: number;
  components: InvoiceTaxComponent[];
}

const ZERO_TAX: InvoiceTaxResult = { taxRate: 0, taxCents: 0, components: [] };

/** CA sales-tax components labeled 'PST' credit the PST/QST Payable account (2200); GST/HST credit 2100. */
function caAccountCodeFor(componentType: string): string {
  return componentType === 'PST' ? '2200' : '2100';
}

/**
 * Compute the tax to apply to a new invoice's subtotal.
 *
 * @param overrideRate - When provided (a fraction, e.g. 0.10), the caller
 *   (a user editing the tax-rate field before submitting) has explicitly
 *   chosen a rate — apply it verbatim instead of looking up the
 *   jurisdiction's default. Still requires an AU/CA jurisdiction so the
 *   correct liability account code is known (an override without a
 *   determinable liability account throws — see below).
 */
export async function computeInvoiceTax(
  tenantId: string,
  subtotalCents: number,
  overrideRate?: number | null,
): Promise<InvoiceTaxResult> {
  if (subtotalCents <= 0) return ZERO_TAX;

  const tenantConfig = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { jurisdiction: true, region: true },
  });
  const jurisdiction = tenantConfig?.jurisdiction || 'us';

  if (jurisdiction === 'au') {
    if (overrideRate != null) {
      const amountCents = Math.round(subtotalCents * overrideRate);
      return {
        taxRate: overrideRate,
        taxCents: amountCents,
        components: amountCents > 0 ? [{ type: 'GST', rate: overrideRate, amountCents, accountCode: '2100' }] : [],
      };
    }
    const result = auSalesTax.calculateTax(subtotalCents, 'standard');
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: result.components
        .filter((c) => c.amountCents > 0)
        .map((c) => ({ type: c.type, rate: c.rate, amountCents: c.amountCents, accountCode: '2100' })),
    };
  }

  if (jurisdiction === 'ca') {
    const region = tenantConfig?.region || '';
    if (overrideRate != null) {
      const amountCents = Math.round(subtotalCents * overrideRate);
      return {
        taxRate: overrideRate,
        taxCents: amountCents,
        components: amountCents > 0 ? [{ type: 'GST', rate: overrideRate, amountCents, accountCode: '2100' }] : [],
      };
    }
    const result = caSalesTax.calculateTax(subtotalCents, region);
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: result.components
        .filter((c) => c.amountCents > 0)
        .map((c) => ({ type: c.type, rate: c.rate, amountCents: c.amountCents, accountCode: caAccountCodeFor(c.type) })),
    };
  }

  // US/UK/other — out of scope for this plan; unchanged zero-tax behavior.
  return ZERO_TAX;
}
```

- [ ] **Step 3: Write the tests**

Create `apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) } },
}));

import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';

beforeEach(() => {
  tenantConfigFindUnique.mockReset();
});

describe('computeInvoiceTax', () => {
  it('returns zero tax for a zero or negative subtotal without querying tenant config', async () => {
    const result = await computeInvoiceTax('t1', 0);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
    expect(tenantConfigFindUnique).not.toHaveBeenCalled();
  });

  it('applies flat 10% GST for an AU tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBe(0.10);
    expect(result.taxCents).toBe(1000);
    expect(result.components).toEqual([{ type: 'GST', rate: 0.10, amountCents: 1000, accountCode: '2100' }]);
  });

  it('applies a single GST/HST component for an ON (HST) tenant, crediting account 2100', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBe(0.13);
    expect(result.taxCents).toBe(1300);
    expect(result.components).toEqual([{ type: 'HST', rate: 0.13, amountCents: 1300, accountCode: '2100' }]);
  });

  it('splits GST and QST into two components with different liability account codes for a QC tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBeCloseTo(0.14975);
    expect(result.taxCents).toBe(1498); // 500 (GST) + 998 (QST), matches ca-pack.test.ts's own fixture
    expect(result.components).toEqual([
      { type: 'GST', rate: 0.05, amountCents: 500, accountCode: '2100' },
      { type: 'PST', rate: 0.09975, amountCents: 998, accountCode: '2200' },
    ]);
  });

  it('returns zero tax for a jurisdiction outside AU/CA scope (e.g. US)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
  });

  it('defaults to us (zero tax) when the tenant has no config row at all', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    const result = await computeInvoiceTax('t1', 10000);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
  });

  it('respects an explicit overrideRate for an AU tenant instead of the jurisdiction default', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000, 0.05);
    expect(result.taxRate).toBe(0.05);
    expect(result.taxCents).toBe(500);
    expect(result.components).toEqual([{ type: 'GST', rate: 0.05, amountCents: 500, accountCode: '2100' }]);
  });

  it('overrideRate of 0 produces zero tax with no components', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000, 0);
    expect(result.taxCents).toBe(0);
    expect(result.components).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web-next && npx vitest run src/__tests__/lib/agentbook-invoice-tax.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/agentbook-invoice-tax.ts apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts
git commit -m "feat(invoice): shared computeInvoiceTax helper for AU/CA sales tax"
```

---

### Task 3: Wire into the plain invoice-create route

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-invoice/invoices/route.ts`
- Modify: `apps/web-next/src/__tests__/api/v1/agentbook-invoice/invoices-route.test.ts` (create this file if no test file for this route already exists — check first: `find apps/web-next/src/__tests__ -ipath "*agentbook-invoice*invoices*"`)

**Interfaces:**
- Consumes: `computeInvoiceTax` from Task 2.
- Produces: nothing new consumed elsewhere — this task's changes are self-contained to this one route.

**Context on the current code:** the `POST` handler computes `totalAmountCents` from line items (this becomes the subtotal), looks up `arAccount`/`revenueAccount`, and posts a 2-line journal entry (debit AR, credit Revenue) using the subtotal as both the invoice's `amountCents` and the journal amounts. This task makes it 3 changes: (a) accept an optional `taxRate` in the request body; (b) call `computeInvoiceTax(tenantId, totalAmountCents, taxRate)` and use the result to compute the grand total; (c) extend the journal entry to credit the tax liability account(s) instead of folding tax into Revenue, and write `AbSalesTaxCollected` rows.

- [ ] **Step 1: Add `taxRate` to the request body type**

In `apps/web-next/src/app/api/v1/agentbook-invoice/invoices/route.ts`, change:

```ts
interface CreateInvoiceBody {
  clientId?: string;
  issuedDate?: string;
  dueDate?: string;
  lines?: InvoiceLine[];
  status?: string;
  currency?: string;
  /** When set (2-60), recognize this invoice's revenue evenly over N months. */
  deferOverMonths?: number;
}
```

to:

```ts
interface CreateInvoiceBody {
  clientId?: string;
  issuedDate?: string;
  dueDate?: string;
  lines?: InvoiceLine[];
  status?: string;
  currency?: string;
  /** When set (2-60), recognize this invoice's revenue evenly over N months. */
  deferOverMonths?: number;
  /**
   * Explicit tax rate override (a fraction, e.g. 0.10), from an editable
   * frontend field. When omitted, the tenant's jurisdiction default
   * applies (AU flat GST, CA province GST/HST/PST) — see computeInvoiceTax.
   */
  taxRate?: number;
}
```

- [ ] **Step 2: Destructure `taxRate` and compute tax after the subtotal**

Find:
```ts
        const { clientId, issuedDate, dueDate, lines, status, currency, deferOverMonths } = body;
```
Change to:
```ts
        const { clientId, issuedDate, dueDate, lines, status, currency, deferOverMonths, taxRate: taxRateOverride } = body;
```

Find:
```ts
        const totalAmountCents = lineItems.reduce((sum, l) => sum + l.amountCents, 0);
```
Add immediately after it:
```ts
        const subtotalCents = totalAmountCents;
        const taxResult = await computeInvoiceTax(tenantId, subtotalCents, taxRateOverride ?? null);
        const grandTotalCents = subtotalCents + taxResult.taxCents;
```

Add the import at the top of the file, alongside the existing imports:
```ts
import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';
```

- [ ] **Step 3: Look up liability accounts (only if tax applies) and fail closed if any required account is missing**

Find:
```ts
        const [arAccount, revenueAccount] = await Promise.all([
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '4000' } } }),
        ]);

        if (!arAccount || !revenueAccount) {
          return {
            status: 422,
            body: {
              success: false,
              error: 'AR account (1100) or Revenue account (4000) not found. Ensure chart of accounts is seeded.',
            },
          };
        }
```

Replace with:
```ts
        const requiredLiabilityCodes = [...new Set(taxResult.components.map((c) => c.accountCode))];
        const [arAccount, revenueAccount, liabilityAccounts] = await Promise.all([
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '4000' } } }),
          requiredLiabilityCodes.length > 0
            ? db.abAccount.findMany({ where: { tenantId, code: { in: requiredLiabilityCodes } } })
            : Promise.resolve([]),
        ]);

        if (!arAccount || !revenueAccount) {
          return {
            status: 422,
            body: {
              success: false,
              error: 'AR account (1100) or Revenue account (4000) not found. Ensure chart of accounts is seeded.',
            },
          };
        }
        const liabilityAccountsByCode = new Map(liabilityAccounts.map((a) => [a.code, a]));
        const missingLiabilityCode = requiredLiabilityCodes.find((code) => !liabilityAccountsByCode.has(code));
        if (missingLiabilityCode) {
          return {
            status: 422,
            body: {
              success: false,
              error: `Tax liability account (${missingLiabilityCode}) not found. Ensure chart of accounts is seeded.`,
            },
          };
        }
```

- [ ] **Step 4: Extend the journal entry to credit the liability account(s), and use the grand total for AR + the invoice's `amountCents`**

Find:
```ts
            const journalEntry = await tx.abJournalEntry.create({
              data: {
                tenantId,
                date: new Date(issuedDate || Date.now()),
                memo: `Invoice ${invoiceNumber} to ${client.name}`,
                sourceType: 'invoice',
                verified: true,
                lines: {
                  create: [
                    { tenantId, accountId: arAccount.id, debitCents: totalAmountCents, creditCents: 0, description: `AR - Invoice ${invoiceNumber}` }, // G-009
                    { tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: totalAmountCents, description: `Revenue - Invoice ${invoiceNumber}` }, // G-009
                  ],
                },
              },
            });

            const inv = await tx.abInvoice.create({
              data: {
                tenantId,
                clientId,
                number: invoiceNumber,
                amountCents: totalAmountCents,
                currency: currency || 'USD',
                issuedDate: new Date(issuedDate || Date.now()),
                dueDate: new Date(dueDate || Date.now()),
                status: status || 'draft',
                journalEntryId: journalEntry.id,
                lines: { create: lineItems },
              },
              include: { lines: true },
            });
```

Replace with:
```ts
            const journalLines = [
              { tenantId, accountId: arAccount.id, debitCents: grandTotalCents, creditCents: 0, description: `AR - Invoice ${invoiceNumber}` }, // G-009
              { tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: subtotalCents, description: `Revenue - Invoice ${invoiceNumber}` }, // G-009
              ...taxResult.components.map((c) => ({
                tenantId, // G-009
                accountId: liabilityAccountsByCode.get(c.accountCode)!.id,
                debitCents: 0,
                creditCents: c.amountCents,
                description: `${c.type} Payable - Invoice ${invoiceNumber}`,
              })),
            ];

            const journalEntry = await tx.abJournalEntry.create({
              data: {
                tenantId,
                date: new Date(issuedDate || Date.now()),
                memo: `Invoice ${invoiceNumber} to ${client.name}`,
                sourceType: 'invoice',
                verified: true,
                lines: { create: journalLines },
              },
            });

            const inv = await tx.abInvoice.create({
              data: {
                tenantId,
                clientId,
                number: invoiceNumber,
                amountCents: grandTotalCents,
                taxRate: taxResult.taxRate || null,
                taxCents: taxResult.taxCents,
                currency: currency || 'USD',
                issuedDate: new Date(issuedDate || Date.now()),
                dueDate: new Date(dueDate || Date.now()),
                status: status || 'draft',
                journalEntryId: journalEntry.id,
                lines: { create: lineItems },
              },
              include: { lines: true },
            });

            if (taxResult.components.length > 0) {
              const taxTenantConfig = await tx.abTenantConfig.findUnique({
                where: { userId: tenantId },
                select: { jurisdiction: true, region: true },
              });
              await tx.abSalesTaxCollected.createMany({
                data: taxResult.components.map((c) => ({
                  tenantId,
                  invoiceId: inv.id,
                  jurisdiction: taxTenantConfig?.jurisdiction || 'us',
                  region: taxTenantConfig?.region || '',
                  taxType: c.type,
                  rate: c.rate,
                  amountCents: c.amountCents,
                })),
              });
            }
```

(`AbSalesTaxCollected` needs `jurisdiction`/`region`, which this route doesn't otherwise fetch — the extra `abTenantConfig.findUnique` above is a second lookup beyond the one `computeInvoiceTax` already did internally. This is deliberate: Task 2's helper keeps its own signature narrow — `tenantId`/`subtotalCents`/`overrideRate` — for clean unit testing, rather than leaking a `jurisdiction`/`region` result field that only this one call site needs. The extra query is cheap and only runs when `taxResult.components.length > 0`, i.e. only for AU/CA tenants.)

- [ ] **Step 5: Update the `AbClient.totalBilledCents` increment and the `invoice.created` event to use the grand total**

Find:
```ts
            await tx.abClient.update({
              where: { id: clientId },
              data: { totalBilledCents: { increment: totalAmountCents } },
            });
```
Change `totalAmountCents` to `grandTotalCents`.

Find the `deferMonths` block's `totalAmountCents: totalAmountCents,` field (inside the `abDeferredRevenue.create` call) — leave this as `subtotalCents` (deferred-revenue recognition schedules should track the *revenue* being recognized over time, not the tax collected on behalf of the government, which is never "recognized as revenue"). Change:
```ts
              await tx.abDeferredRevenue.create({
                data: {
                  tenantId,
                  invoiceId: inv.id,
                  totalAmountCents,
```
to:
```ts
              await tx.abDeferredRevenue.create({
                data: {
                  tenantId,
                  invoiceId: inv.id,
                  totalAmountCents: subtotalCents,
```

Find the `invoice.created` `AbEvent`'s `amountCents: totalAmountCents,` and change it to `amountCents: grandTotalCents,` (and add `subtotalCents, taxCents: taxResult.taxCents,` alongside it for observability):
```ts
                action: {
                  invoiceId: inv.id,
                  number: invoiceNumber,
                  clientId,
                  amountCents: grandTotalCents,
                  subtotalCents,
                  taxCents: taxResult.taxCents,
                  lineCount: lineItems.length,
                },
```

Find the post-transaction `audit()` call's `amountCents: totalAmountCents,` and change it to `amountCents: grandTotalCents,` the same way.

- [ ] **Step 6: Write the route test file**

First run `find apps/web-next/src/__tests__ -ipath "*agentbook-invoice*invoices*"` to check whether a test file for this route already exists. If one exists, read it fully and add new test cases to it following its exact existing mocking conventions (mirror the style already used in `apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts` from Launch-gap PR-5 — a `vi.mock('@naap/database', ...)` object with only the methods this route calls, `vi.mock('server-only', () => ({}))`, importing `POST` directly and calling it with a `NextRequest`). If none exists, create `apps/web-next/src/__tests__/api/v1/agentbook-invoice/invoices-route.test.ts` with at minimum these cases (adapt exact mock shape to match whatever the route imports):
  - Creating an invoice for a US tenant produces a 2-line journal entry (AR debit, Revenue credit) exactly as before, `taxCents: 0`, `taxRate: null`, and no `abSalesTaxCollected.createMany` call.
  - Creating an invoice for an AU tenant with a $1000.00 line item produces a 3-line journal entry (AR debit $1100.00, Revenue credit $1000.00, GST Payable (2100) credit $100.00), the invoice row has `taxCents: 10000, taxRate: 0.10`, and `abSalesTaxCollected.createMany` is called with one row (`taxType: 'GST', rate: 0.10, amountCents: 10000`).
  - Creating an invoice for a QC (Canadian) tenant produces a 4-line journal entry (AR, Revenue, GST Payable (2100), PST Payable (2200)) and two `AbSalesTaxCollected` rows.
  - An explicit `taxRate` in the request body overrides the jurisdiction default for an AU tenant.
  - Missing the liability account (e.g. `2100` not seeded) for an AU tenant with tax due returns a 422 with a clear error message, and no invoice/journal entry is created (transaction never opened, or rolled back — confirm the account lookup 422 happens before `db.$transaction` is called).

- [ ] **Step 7: Run the test file**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-invoice/invoices-route.test.ts` (or whatever path Step 6 determined)
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-invoice/invoices/route.ts apps/web-next/src/__tests__/api/v1/agentbook-invoice/
git commit -m "feat(invoice): compute AU/CA sales tax on invoice creation"
```

---

### Task 4: Wire into `createInvoiceDraft` (chat/NL invoice drafts — 4 call sites at once)

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-invoice-draft.ts`
- Modify (or create): the test file covering this helper — check `find apps/web-next/src/__tests__ -ipath "*invoice-draft*"` first.

**Interfaces:**
- Consumes: `computeInvoiceTax` from Task 2.
- Produces: nothing new — `createInvoiceDraft`'s existing `CreateDraftResult` return type gains `taxCents`/`taxRate` fields, consumed by whatever the 4 call sites do with the result today (they already read `totalCents`; no call site needs to change its own logic, only its display, which is out of scope for this task per the plan's frontend task being scoped to `NewInvoice.tsx` only — the chat/Telegram response templates are not touched here, matching scope discipline; if a reviewer flags that chat responses should also show tax, that's a follow-up, not blocking).

**Context on the current code:** this shared helper computes `totalAmountCents` (after optional FX conversion into the tenant's booking currency) and creates an `AbInvoice` row directly with **no journal entry at all** (drafts don't post to the GL — confirmed by reading the full file, no `abJournalEntry` reference anywhere). This task adds tax computation on the FX-converted subtotal and persists `taxCents`/`taxRate` on the draft row and writes `AbSalesTaxCollected` rows — it does **not** add journal-entry posting, since that's not this helper's job today and adding it would be a scope-expanding, unrelated change.

- [ ] **Step 1: Add the import**

At the top of `apps/web-next/src/lib/agentbook-invoice-draft.ts`, add:
```ts
import { computeInvoiceTax } from './agentbook-invoice-tax';
```

- [ ] **Step 2: Compute tax after the FX-converted total is known**

Find:
```ts
  const lineItems = fx ? fx.bookedLineItems : quotedLineItems;
  const totalAmountCents = fx ? fx.bookedTotalCents : quotedTotalCents;
```

Add immediately after it:
```ts
  const subtotalCents = totalAmountCents;
  const taxResult = await computeInvoiceTax(input.tenantId, subtotalCents);
  const grandTotalCents = subtotalCents + taxResult.taxCents;
```

(No `overrideRate` parameter here — chat/NL-drafted invoices have no UI moment for the user to specify a rate; the jurisdiction default always applies. A user can still edit the draft's tax rate later via the invoice-edit UI once one exists — out of scope for this plan, matching its "invoice-creation" framing, not "invoice-editing".)

- [ ] **Step 3: Persist the tax fields, write `AbSalesTaxCollected`, and use the grand total as `amountCents`**

Find (inside the retry loop's `db.$transaction`):
```ts
        return tx.abInvoice.create({
          data: {
            tenantId: input.tenantId,
            clientId: input.client.id,
            number: invoiceNumber,
            amountCents: totalAmountCents,
            currency,
```
Change `amountCents: totalAmountCents,` to:
```ts
            amountCents: grandTotalCents,
            taxRate: taxResult.taxRate || null,
            taxCents: taxResult.taxCents,
            currency,
```

After the `db.$transaction` call resolves (the existing code already does the `AbEvent` create outside the transaction — "so a slow event write can't hold the row locks"), and BEFORE that `AbEvent` create, add the `AbSalesTaxCollected` writes (also outside the transaction, for the same lock-holding reason, and because `AbSalesTaxCollected` lives in a different Postgres schema — `plugin_agentbook_tax` — than `AbInvoice`'s `plugin_agentbook_invoice`, so it was never going to be part of the same transaction's schema-scoped guarantees regardless):

Find:
```ts
      // Outside the txn so a slow event write can't hold the row locks.
      await db.abEvent.create({
```
Insert immediately before it:
```ts
      if (taxResult.components.length > 0) {
        const taxTenantConfig = await db.abTenantConfig.findUnique({
          where: { userId: input.tenantId },
          select: { jurisdiction: true, region: true },
        });
        await db.abSalesTaxCollected.createMany({
          data: taxResult.components.map((c) => ({
            tenantId: input.tenantId,
            invoiceId: inv.id,
            jurisdiction: taxTenantConfig?.jurisdiction || 'us',
            region: taxTenantConfig?.region || '',
            taxType: c.type,
            rate: c.rate,
            amountCents: c.amountCents,
          })),
        });
      }

      // Outside the txn so a slow event write can't hold the row locks.
      await db.abEvent.create({
```

- [ ] **Step 4: Update the return value and the `invoice.drafted_from_chat` event's amount fields**

Find:
```ts
export interface CreateDraftResult {
  draftId: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string | null;
  totalCents: number;
```
Add two fields after `totalCents`:
```ts
export interface CreateDraftResult {
  draftId: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string | null;
  totalCents: number;
  taxCents: number;
  taxRate: number | null;
```

Find the final `return { ... }` block (after the `AbEvent` create) and add `taxCents: taxResult.taxCents, taxRate: taxResult.taxRate || null,` alongside the existing `totalCents: totalAmountCents,` (which itself should now read `totalCents: grandTotalCents,` — `totalCents` in this return type has always meant "what the client owes," matching `amountCents`'s semantics, so it must include tax now too):
```ts
      return {
        draftId: inv.id,
        invoiceNumber: inv.number,
        clientName: input.client.name,
        clientEmail: input.client.email,
        totalCents: grandTotalCents,
        taxCents: taxResult.taxCents,
        taxRate: taxResult.taxRate || null,
        lines: inv.lines.map((l) => ({
```

Also find the `invoice.drafted_from_chat` `AbEvent`'s `amountCents: totalAmountCents,` and change it to `amountCents: grandTotalCents,` (add `subtotalCents, taxCents: taxResult.taxCents,` alongside for observability, matching Task 3's pattern):
```ts
          action: {
            invoiceId: inv.id,
            number: inv.number,
            clientId: input.client.id,
            amountCents: grandTotalCents,
            subtotalCents,
            taxCents: taxResult.taxCents,
            lineCount: lineItems.length,
```

- [ ] **Step 5: Confirm all 4 call sites still compile against the changed return type**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "invoice-draft\|draft-from-text\|from-time-entries\|estimates/\[id\]/convert\|agentbook-bot-agent"`
Expected: no new errors (the two added fields are additive to the interface, so nothing should break; `totalCents` changing meaning from "subtotal" to "grand total" could only break a caller that assumed it equaled the sum of line items — confirm none of the 4 call sites does that assumption by reading how each uses `result.totalCents`; if one does, that's a real bug this step must catch, not silently pass over).

- [ ] **Step 6: Write/extend tests**

Follow the same pattern as Task 2's test file (mock `@naap/database`, mock `server-only`, import `createInvoiceDraft` directly). Cover: a US-tenant draft has `taxCents: 0`; an AU-tenant draft has the correct `taxCents`/`taxRate` and writes one `AbSalesTaxCollected` row via `db.abSalesTaxCollected.createMany`; the FX-conversion path (quoted in a foreign currency) computes tax on the *converted* (booked) total, not the original quoted total.

- [ ] **Step 7: Run the tests**

Run whatever command Step 6 determined the right test file/path to be.
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/lib/agentbook-invoice-draft.ts apps/web-next/src/__tests__/
git commit -m "feat(invoice): compute AU/CA sales tax in the shared chat/NL invoice-draft helper"
```

---

### Task 5: Wire into the recurring-invoice cron

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/cron/recurring-invoices/route.ts`
- Create: `apps/web-next/src/__tests__/api/v1/agentbook/cron/recurring-invoices.test.ts` (check first whether one already exists: `find apps/web-next/src/__tests__ -ipath "*recurring-invoice*"`)

**Interfaces:**
- Consumes: `computeInvoiceTax` from Task 2.
- Produces: nothing new consumed elsewhere.

**Context on the current code:** this cron reads `item.totalCents` (already-decided line-item total from the `AbRecurringInvoice` template) and posts the same 2-line (AR/Revenue) journal entry pattern as Task 3's route, using `item.totalCents` directly as both the journal amounts and the invoice's `amountCents`. This task applies the identical tax-computation-and-3/4-line-journal-entry treatment as Task 3.

- [ ] **Step 1: Add the import**

At the top of the file, add:
```ts
import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';
```

- [ ] **Step 2: Compute tax and look up liability accounts alongside the existing AR/Revenue lookup**

Find:
```ts
      // Look up accounts
      const arAccount = await db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '1100' } });
      const revenueAccount = await db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '4000' } });
      if (!arAccount || !revenueAccount) continue;
```

Replace with:
```ts
      const subtotalCents = item.totalCents;
      const taxResult = await computeInvoiceTax(item.tenantId, subtotalCents);
      const grandTotalCents = subtotalCents + taxResult.taxCents;

      // Look up accounts
      const requiredLiabilityCodes = [...new Set(taxResult.components.map((c) => c.accountCode))];
      const [arAccount, revenueAccount, liabilityAccounts] = await Promise.all([
        db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '1100' } }),
        db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '4000' } }),
        requiredLiabilityCodes.length > 0
          ? db.abAccount.findMany({ where: { tenantId: item.tenantId, code: { in: requiredLiabilityCodes } } })
          : Promise.resolve([]),
      ]);
      if (!arAccount || !revenueAccount) continue;
      const liabilityAccountsByCode = new Map(liabilityAccounts.map((a) => [a.code, a]));
      if (requiredLiabilityCodes.some((code) => !liabilityAccountsByCode.has(code))) {
        // Best-effort cron: skip this item rather than crash the whole
        // batch. Logged so a missing chart-of-accounts seed is visible.
        console.warn(`[cron/recurring-invoices] skipping ${item.id}: missing tax liability account`);
        continue;
      }
```

(Note: this cron's existing style already silently `continue`s past a missing AR/Revenue account with no logging — this task adds a `console.warn` for the new liability-account case specifically because a silently-skipped recurring invoice due to a missing tax account is exactly the kind of "silent ledger-integrity gap" this whole roadmap exists to close; it does not retrofit logging onto the pre-existing AR/Revenue `continue`, which is out of scope here.)

- [ ] **Step 3: Extend the journal entry and invoice creation**

Find:
```ts
      await db.$transaction(async (tx) => {
        const je = await tx.abJournalEntry.create({
          data: {
            tenantId: item.tenantId, date: now,
            memo: `Recurring Invoice ${invoiceNumber} to ${client.name}`,
            sourceType: 'invoice', verified: true,
            lines: {
              create: [
                { tenantId: item.tenantId, accountId: arAccount.id, debitCents: item.totalCents, creditCents: 0, description: `AR - ${invoiceNumber}` }, // G-009
                { tenantId: item.tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: item.totalCents, description: `Revenue - ${invoiceNumber}` }, // G-009
              ],
            },
          },
        });

        const inv = await tx.abInvoice.create({
          data: {
            tenantId: item.tenantId, clientId: item.clientId, number: invoiceNumber,
            amountCents: item.totalCents, currency: item.currency,
            issuedDate: now, dueDate,
            status: item.autoSend ? 'sent' : 'draft',
            source: 'recurring',
            journalEntryId: je.id, recurringId: item.id,
            lines: { create: lines },
          },
        });

        await tx.abJournalEntry.update({ where: { id: je.id }, data: { sourceId: inv.id } });
        await tx.abClient.update({ where: { id: item.clientId }, data: { totalBilledCents: { increment: item.totalCents } } });

        await tx.abEvent.create({
          data: {
            tenantId: item.tenantId, eventType: 'invoice.auto_generated', actor: 'system',
            action: { invoiceId: inv.id, number: invoiceNumber, recurringId: item.id },
          },
        });
      });
```

Replace with:
```ts
      await db.$transaction(async (tx) => {
        const journalLines = [
          { tenantId: item.tenantId, accountId: arAccount.id, debitCents: grandTotalCents, creditCents: 0, description: `AR - ${invoiceNumber}` }, // G-009
          { tenantId: item.tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: subtotalCents, description: `Revenue - ${invoiceNumber}` }, // G-009
          ...taxResult.components.map((c) => ({
            tenantId: item.tenantId, // G-009
            accountId: liabilityAccountsByCode.get(c.accountCode)!.id,
            debitCents: 0,
            creditCents: c.amountCents,
            description: `${c.type} Payable - ${invoiceNumber}`,
          })),
        ];

        const je = await tx.abJournalEntry.create({
          data: {
            tenantId: item.tenantId, date: now,
            memo: `Recurring Invoice ${invoiceNumber} to ${client.name}`,
            sourceType: 'invoice', verified: true,
            lines: { create: journalLines },
          },
        });

        const inv = await tx.abInvoice.create({
          data: {
            tenantId: item.tenantId, clientId: item.clientId, number: invoiceNumber,
            amountCents: grandTotalCents,
            taxRate: taxResult.taxRate || null,
            taxCents: taxResult.taxCents,
            currency: item.currency,
            issuedDate: now, dueDate,
            status: item.autoSend ? 'sent' : 'draft',
            source: 'recurring',
            journalEntryId: je.id, recurringId: item.id,
            lines: { create: lines },
          },
        });

        await tx.abJournalEntry.update({ where: { id: je.id }, data: { sourceId: inv.id } });
        await tx.abClient.update({ where: { id: item.clientId }, data: { totalBilledCents: { increment: grandTotalCents } } });

        if (taxResult.components.length > 0) {
          const taxTenantConfig = await tx.abTenantConfig.findUnique({
            where: { userId: item.tenantId },
            select: { jurisdiction: true, region: true },
          });
          await tx.abSalesTaxCollected.createMany({
            data: taxResult.components.map((c) => ({
              tenantId: item.tenantId,
              invoiceId: inv.id,
              jurisdiction: taxTenantConfig?.jurisdiction || 'us',
              region: taxTenantConfig?.region || '',
              taxType: c.type,
              rate: c.rate,
              amountCents: c.amountCents,
            })),
          });
        }

        await tx.abEvent.create({
          data: {
            tenantId: item.tenantId, eventType: 'invoice.auto_generated', actor: 'system',
            action: { invoiceId: inv.id, number: invoiceNumber, recurringId: item.id, amountCents: grandTotalCents, taxCents: taxResult.taxCents },
          },
        });
      });
```

- [ ] **Step 4: Write the test file**

Create `apps/web-next/src/__tests__/api/v1/agentbook/cron/recurring-invoices.test.ts` (mirroring this repo's established mocking conventions for cron routes — check an existing cron test file such as `apps/web-next/src/__tests__/api/v1/agentbook/cron/` if one exists for a sibling cron, for the exact mock shape and `CRON_SECRET` header handling). Cover: an AU-tenant recurring item generates an invoice with correct `taxCents`/3-line journal entry; a US-tenant item is unaffected (2-line journal entry, `taxCents: 0`); a recurring item whose tenant is missing the required liability account is skipped (not crashed) and logs a warning, while other due items still process normally in the same cron run.

- [ ] **Step 5: Run the tests**

Run the test file created in Step 4.
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/recurring-invoices/route.ts apps/web-next/src/__tests__/api/v1/agentbook/cron/
git commit -m "feat(invoice): compute AU/CA sales tax in the recurring-invoice cron"
```

---

### Task 6: Invoice-creation frontend — editable tax-rate field

**Files:**
- Modify: `plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx`

**Interfaces:**
- Consumes: nothing new from earlier tasks (the frontend doesn't import backend code — it's a separately-bundled Vite plugin frontend).
- Produces: an additional `taxRate` field in the POST body to `${API}/invoices`, which Task 3's route now accepts.

**Context on the current code:** the tenant-config fetch (lines 78-88) currently only reads `data.currency`. This task extends it to also read `data.jurisdiction`/`data.region`, adds a small client-side default-rate lookup (a preview only — the backend in Task 3 is the authoritative computation), and adds an editable "Tax rate" field plus Subtotal/Tax/Total display rows, shown only when the tenant's jurisdiction is AU or CA.

- [ ] **Step 1: Add jurisdiction/region state and extend the tenant-config fetch**

Find:
```ts
  // Multi-currency (PR 13)
  const [tenantCurrency, setTenantCurrency] = useState<string>('USD');
  const [currency, setCurrency] = useState<string>('USD');
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
```
Add after it:
```ts
  // Sales tax (Launch-gap PR-6) — AU/CA only, per computeInvoiceTax's scope.
  const [jurisdiction, setJurisdiction] = useState<string>('us');
  const [region, setRegion] = useState<string>('');
  const [taxRatePercent, setTaxRatePercent] = useState<number>(0);
```

Find:
```ts
  // Load tenant booking currency (defaults the selector).
  useEffect(() => {
    fetch(`${CORE_API}/tenant-config`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data?.currency) {
          setTenantCurrency(d.data.currency);
          setCurrency(d.data.currency);
        }
      })
      .catch(() => {});
  }, []);
```
Replace with:
```ts
  // Load tenant booking currency + jurisdiction (defaults the currency
  // selector and the tax-rate field below).
  useEffect(() => {
    fetch(`${CORE_API}/tenant-config`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data?.currency) {
          setTenantCurrency(d.data.currency);
          setCurrency(d.data.currency);
        }
        if (d.success && d.data?.jurisdiction) {
          setJurisdiction(d.data.jurisdiction);
          setRegion(d.data.region || '');
          setTaxRatePercent(defaultTaxRatePercent(d.data.jurisdiction, d.data.region || ''));
        }
      })
      .catch(() => {});
  }, []);
```

- [ ] **Step 2: Add the client-side default-rate preview table**

Add near the top of the file, after the existing `CURRENCY_OPTIONS` constant:
```ts
// Client-side PREVIEW ONLY, mirroring packages/agentbook-jurisdictions/src/{au,ca}/sales-tax.ts —
// the backend (computeInvoiceTax) is the authoritative computation and is
// what actually gets persisted; this just pre-fills an editable field so
// the user isn't staring at "0%" for AU/CA tenants. Keep in sync with
// those two files if their rates ever change.
const CA_PROVINCE_RATES: Record<string, number> = {
  AB: 5, BC: 12, SK: 11, MB: 12, ON: 13, QC: 14.975,
  NB: 15, NS: 15, NL: 15, PE: 15, NT: 5, NU: 5, YT: 5,
};

function defaultTaxRatePercent(jurisdiction: string, region: string): number {
  if (jurisdiction === 'au') return 10;
  if (jurisdiction === 'ca') return CA_PROVINCE_RATES[region.toUpperCase()] ?? 0;
  return 0;
}
```

- [ ] **Step 3: Compute subtotal/tax/total for display, and only show the tax UI for AU/CA**

Find:
```ts
  const total = lineItems.reduce((sum, li) => sum + li.quantity * li.rate, 0);
```
Replace with:
```ts
  const subtotal = lineItems.reduce((sum, li) => sum + li.quantity * li.rate, 0);
  const showTaxField = jurisdiction === 'au' || jurisdiction === 'ca';
  const taxAmount = showTaxField ? subtotal * (taxRatePercent / 100) : 0;
  const total = subtotal + taxAmount;
```

- [ ] **Step 4: Send `taxRate` in the POST body when applicable**

Find:
```ts
        body: JSON.stringify({
          clientId,
          issuedDate: invoiceDate,
          dueDate: dueDate.toISOString().slice(0, 10),
          status,
          currency: tenantCurrency,
          lines: bookedLines,
          ...(deferEnabled && deferMonths >= 2 ? { deferOverMonths: deferMonths } : {}),
```
Add a `taxRate` entry right after `lines: bookedLines,`:
```ts
        body: JSON.stringify({
          clientId,
          issuedDate: invoiceDate,
          dueDate: dueDate.toISOString().slice(0, 10),
          status,
          currency: tenantCurrency,
          lines: bookedLines,
          ...(showTaxField ? { taxRate: taxRatePercent / 100 } : {}),
          ...(deferEnabled && deferMonths >= 2 ? { deferOverMonths: deferMonths } : {}),
```

- [ ] **Step 5: Add the UI — Subtotal/Tax-rate-input/Tax/Total, replacing the current single Total row**

Find:
```tsx
        {/* Total + actions */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          <div className="flex items-center justify-between mb-6">
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Total
            </span>
            <span className="text-2xl font-bold text-foreground">
              {formatCurrency(total, currency)}
            </span>
          </div>
```
Replace with:
```tsx
        {/* Subtotal / tax / total + actions */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          {showTaxField ? (
            <div className="mb-6 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Subtotal</span>
                <span className="text-sm font-medium text-foreground">{formatCurrency(subtotal, currency)}</span>
              </div>
              <div className="flex items-center justify-between">
                <label htmlFor="tax-rate" className="text-sm text-muted-foreground">
                  Tax rate (%)
                </label>
                <input
                  id="tax-rate"
                  type="number"
                  min={0}
                  max={100}
                  step={0.001}
                  value={taxRatePercent}
                  onChange={(e) => setTaxRatePercent(parseFloat(e.target.value) || 0)}
                  className="w-24 px-2 py-1 text-sm text-right rounded-lg border border-border bg-background text-foreground"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Tax</span>
                <span className="text-sm font-medium text-foreground">{formatCurrency(taxAmount, currency)}</span>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Total</span>
                <span className="text-2xl font-bold text-foreground">{formatCurrency(total, currency)}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between mb-6">
              <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Total
              </span>
              <span className="text-2xl font-bold text-foreground">
                {formatCurrency(total, currency)}
              </span>
            </div>
          )}
```

- [ ] **Step 6: Update the per-line-item display, which still shows `li.quantity * li.rate` — confirm this is unchanged (it should be, since tax is invoice-level, not per-line) and update the total displayed inline where line items render**

Read the section around what was previously line 456-460 (`{formatCurrency(li.quantity * li.rate, currency)}`) — this stays exactly as-is; a line item's own displayed amount is never tax-inclusive, only the invoice grand total is. No change needed here; this step is a verification checkpoint, not a code change — confirm no other place in the file computes a total by summing rendered line amounts in a way that would now double-count or omit tax.

- [ ] **Step 7: Manual verification (frontend build + local check)**

Run: `cd plugins/agentbook-invoice/frontend && npm run build`
Expected: build succeeds with no new TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add plugins/agentbook-invoice/frontend/src/pages/NewInvoice.tsx
git commit -m "feat(invoice): editable AU/CA tax-rate field on invoice creation"
```

---

### Task 7: Full verification, PR, and production rollout

**Files:** none (verification-only task).

- [ ] **Step 1: Run every affected package's full test suite**

```bash
cd apps/web-next && npx vitest run
```
Expected: no failures beyond any already-established pre-existing/unrelated failures — confirm any failure exists on a clean `origin/main` checkout before treating it as pre-existing, per this session's established practice.

- [ ] **Step 2: Typecheck**

```bash
cd apps/web-next && npx tsc --noEmit
```
Expected: no new errors introduced by this branch.

- [ ] **Step 3: Build the invoice plugin frontend and copy it to the CDN path**

```bash
cd plugins/agentbook-invoice/frontend && npm run build
cp dist/production/agentbook-invoice.js ../../../apps/web-next/public/cdn/plugins/agentbook-invoice/agentbook-invoice.js
cp dist/production/agentbook-invoice.js ../../../apps/web-next/public/cdn/plugins/agentbook-invoice/1.0.0/agentbook-invoice.js
```
Confirm the built bundle is committed alongside the source change (per this session's established "Plugin frontend deploy" practice — the built CDN artifact must be committed, not just the source).

- [ ] **Step 4: Manual verification against an isolated Postgres**

Bootstrap a fresh throwaway container (as in Task 1), seed one AU tenant and one CA (Quebec) tenant with their jurisdiction packs' chart of accounts (via the existing `seed-jurisdiction` route or a direct script using `auChartOfAccounts`/`caChartOfAccounts`), and confirm end-to-end: creating a $1000 invoice for the AU tenant produces `taxCents: 10000`, a 3-line journal entry, and one `AbSalesTaxCollected` row; creating a $1000 invoice for the QC tenant produces `taxCents: 14975`... **correction: use whole-dollar test amounts that avoid float-rounding ambiguity in this manual check** — a $100.00 (10000-cent) invoice for QC should show `taxCents: 1498` (500 GST + 998 QST, matching Task 2's own test fixture) and two `AbSalesTaxCollected` rows.

- [ ] **Step 5: Final whole-branch review**

Dispatch a code-reviewer subagent on the most capable available model, pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically verify: (a) every write path this plan claims to fix is confirmed as one that reaches production (re-derive this independently, don't just trust the plan's own claim, matching the rigor established in Launch-gap PR-5's final review); (b) the journal-entry math balances in every case (debits == credits) for both the AU flat-rate case and CA's multi-component case; (c) `amountCents`'s meaning (tax-inclusive grand total) is applied consistently everywhere it's read across this diff — no leftover reference to the old "amountCents == subtotal" assumption; (d) the frontend's client-side preview table cannot silently diverge from the backend's authoritative computation in a way that would surprise a user (the backend is always the source of truth for what's persisted, but confirm the plan's Step 5/Task 6 preview values match Task 2's real engine outputs for every CA province, not just the ones in the plan's own examples).

- [ ] **Step 6: Push, open PR, wait for CI**

Follow this session's established pattern: push the branch, open a PR describing the fix, wait for CI. The chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to any of the last several PRs' diffs) is expected and safe to merge past once independently re-confirmed via `gh run view --job --log` for this specific PR's run.

- [ ] **Step 7: Production rollout**

After merge: run the new migration (Task 1) against production as its own explicit, separately-confirmed step — BEFORE the code deploy, per this session's established practice for schema changes reaching production (get explicit user confirmation before this step, since it writes to the production database). Then deploy via the established `vercel pull/build/deploy --prebuilt --prod` flow. Manually verify in production: create a real invoice for an AU or CA test persona tenant (if one exists in the seeded test accounts — check `agentbook/users.md` for a persona whose `businessType`/jurisdiction is already AU/CA; Maya is CA per CLAUDE.md's test-account table) and confirm the tax computes correctly, the journal entry balances, and `AbSalesTaxCollected` gets a row (query it directly, matching the verification style established in Launch-gap PR-5's production check).
