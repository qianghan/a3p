# Launch-gap PR-2: Jurisdiction-aware chart of accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboarding's "we'll create a chart of accounts based on your tax jurisdiction" promise is currently a lie — the live route always seeds the US Schedule-C chart regardless of `AbTenantConfig.jurisdiction`, with a `TODO` admitting it. Wire the route to the real, already-tested `usChartOfAccounts`/`caChartOfAccounts`/`auChartOfAccounts` jurisdiction packs instead.

**Architecture:** Same "wired twice, not built once" fix pattern as Launch-gap PR-1: a correct jurisdiction-pack layer already exists in `packages/agentbook-jurisdictions/src/{us,ca,au}/chart-of-accounts.ts` (each exporting a `ChartOfAccountsTemplate` with `getDefaultAccounts(businessType)`/`getTaxCategoryMapping()`), but the live route has its own separate, duplicated, US-only inline account list instead of calling it. Replace the route's hardcoded `US_ACCOUNTS` array with a jurisdiction-keyed lookup into the three real packs.

**Tech Stack:** Next.js route handler (`apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts`), Prisma (`AbAccount.upsert`), Vitest.

## Global Constraints

- No file under `packages/agentbook-jurisdictions/src/` is modified — only imported and called. All three packs (us/ca/au) are already correct and tested; this PR is a consumer wiring fix, not a chart-design change.
- **All three jurisdictions (us/ca/au) are switched to the real packs, not just ca/au.** The route's current inline `US_ACCOUNTS` (20 accounts) is itself a stale, less-complete duplicate of the real `usChartOfAccounts` pack (32 accounts, e.g. missing a Depreciation line, missing split mortgage/other interest lines) — leaving `us` on the old inline array while `ca`/`au` get the real packs would mean the same route sources its data three different ways for no reason. This exactly mirrors the precedent set and reviewer-confirmed in Launch-gap PR-1 Task 1, which also replaced the "already technically correct for `us`" inline logic alongside the new `au` support, for the same reason: one consistent source of truth beats a partial fix that looks done but leaves a duplicate lying around.
- `businessType === 'student'` keeps its own separate `STUDENT_ACCOUNTS` list, completely unchanged — this is a business-type distinction (tuition/scholarship/gig income isn't a Schedule-C business in any jurisdiction), not a jurisdiction distinction, and there is no per-jurisdiction student chart pack to consume. Do not touch this branch's contents.
- Unrecognized/missing jurisdiction values must still default gracefully to the US chart (matching prior behavior), never throw.
- The legacy Express mirror (`plugins/agentbook-core/backend/src/server.ts`'s `POST /api/v1/agentbook-core/accounts/seed-jurisdiction` handler, and its own inline `US_ACCOUNTS`/`STUDENT_ACCOUNTS` copies) is confirmed dead code in production: `apps/web-next/src/lib/agentbook-config.ts` routes `/api/v1/agentbook-core` through `process.env.AGENTBOOK_CORE_URL ?? appBase`, and `AGENTBOOK_CORE_URL` is never set anywhere except a commented-out line in `.env.example` — so relative fetches from the frontend always resolve to the Next.js route in production, never this Express backend. Do not modify `server.ts` — wasted effort on unreachable code, same reasoning Launch-gap PR-1 used to exclude the equivalent tax legacy handler.
- The DB write shape is unchanged: `AbAccount.upsert({ where: { tenantId_code }, update: { name, accountType, taxCategory }, create: { tenantId, code, name, accountType, taxCategory } })`, still run through `db.$transaction(accounts.map(...))`. Response shape (`{ success: true, data: { count } }`) is unchanged.

---

### Task 1: Replace hardcoded US-only chart with real us/ca/au jurisdiction packs

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts`
- Test: `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/__tests__/route.test.ts` (new)

**Interfaces:**
- Consumes: `usChartOfAccounts`/`caChartOfAccounts`/`auChartOfAccounts` from `@agentbook/jurisdictions/{us,ca,au}/chart-of-accounts` (each implementing `ChartOfAccountsTemplate` from `@agentbook/jurisdictions/interfaces`: `getDefaultAccounts(businessType: string): Account[]` where `Account = { code: string; name: string; type: 'asset'|'liability'|'equity'|'revenue'|'expense'; taxCategory?: string; parent?: string }` — note the pack's field is `type`, the DB/route's field is `accountType`; the mapping step below converts one to the other).
- Produces: no new exports; this task only changes route internals.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const accountUpsert = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: {
      upsert: (...a: unknown[]) => {
        accountUpsert(...a);
        return Promise.resolve({ id: 'acct-1', ...(a[0] as { create: Record<string, unknown> }).create });
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function req(): NextRequest {
  return new NextRequest('http://x/accounts/seed-jurisdiction', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('POST /agentbook-core/accounts/seed-jurisdiction', () => {
  it('seeds the real AU BAS-aligned chart for jurisdiction=au', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'au' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(33);
    const codes = accountUpsert.mock.calls.map((c) => (c[0] as { create: { code: string } }).create.code);
    expect(codes).toContain('2100'); // GST Payable
    expect(codes).toContain('2300'); // Superannuation Payable
    const gstLine = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '2100');
    expect((gstLine![0] as { create: { name: string } }).create.name).toBe('GST Payable');
  });

  it('seeds the real CA T2125-aligned chart for jurisdiction=ca', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'ca' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(33);
    const gstHst = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '2100');
    expect((gstHst![0] as { create: { name: string } }).create.name).toBe('GST/HST Payable');
    const revenue = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '4000');
    expect((revenue![0] as { create: { taxCategory?: string } }).create.taxCategory).toBe('Line 8000 - Professional income');
  });

  it('seeds the real (32-account) US Schedule-C chart for jurisdiction=us', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(32);
    // Depreciation (6800) exists in the real pack but not in the old inline US_ACCOUNTS list.
    const depreciation = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '6800');
    expect(depreciation).toBeDefined();
    expect((depreciation![0] as { create: { name: string } }).create.name).toBe('Depreciation');
  });

  it('falls back to the US chart for a missing/unrecognized jurisdiction, without throwing', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: '' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.count).toBe(32);
  });

  it('still seeds STUDENT_ACCOUNTS for businessType=student regardless of jurisdiction (regression)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'student', jurisdiction: 'au' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(14);
    const codes = accountUpsert.mock.calls.map((c) => (c[0] as { create: { code: string } }).create.code);
    expect(codes).toContain('4200'); // Scholarship / Grant Income
    // Confirm this did NOT pick up the AU chart's GST Payable account.
    expect(codes).not.toContain('2100');
  });

  it('upserts by (tenantId, code) with update+create, matching the existing re-runnable pattern', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
    const { POST } = await import('../route');
    await POST(req());

    const cashCall = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '1000');
    expect(cashCall![0]).toMatchObject({
      where: { tenantId_code: { tenantId: 'tenant-1', code: '1000' } },
      update: { name: 'Cash', accountType: 'asset', taxCategory: undefined },
      create: { tenantId: 'tenant-1', code: '1000', name: 'Cash', accountType: 'asset', taxCategory: undefined },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/__tests__/route.test.ts`
Expected: FAIL — the `au`/`ca` tests get 20 US-only accounts back (from the current hardcoded `US_ACCOUNTS`) instead of the real 33-account AU/CA charts; the `us` test gets 20 instead of 32; no `Depreciation` account exists yet.

- [ ] **Step 3: Rewrite the route**

Find (the full current file):

```ts
/**
 * Seed a default chart of accounts for the tenant's jurisdiction.
 *
 * Uses the US Schedule-C-style chart for now (the legacy handler also
 * defaults to US even when jurisdiction='ca'). Re-runnable: upserts
 * by (tenantId, code).
 *
 * businessType='student' gets a separate set — tuition/scholarship/gig
 * income isn't a Schedule-C business and the US_ACCOUNTS categories
 * (Commissions & Fees, Contract Labor, Legal & Professional, ...) don't
 * match what a student actually needs to track.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const US_ACCOUNTS: { code: string; name: string; accountType: string; taxCategory?: string }[] = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1100', name: 'Accounts Receivable', accountType: 'asset' },
  { code: '1200', name: 'Business Checking', accountType: 'asset' },
  { code: '2000', name: 'Accounts Payable', accountType: 'liability' },
  { code: '2100', name: 'Sales Tax Payable', accountType: 'liability' },
  { code: '3000', name: "Owner's Equity", accountType: 'equity' },
  { code: '4000', name: 'Service Revenue', accountType: 'revenue', taxCategory: 'Line 1' },
  { code: '5000', name: 'Advertising', accountType: 'expense', taxCategory: 'Line 8' },
  { code: '5100', name: 'Car & Truck', accountType: 'expense', taxCategory: 'Line 9' },
  { code: '5200', name: 'Commissions & Fees', accountType: 'expense', taxCategory: 'Line 10' },
  { code: '5300', name: 'Contract Labor', accountType: 'expense', taxCategory: 'Line 11' },
  { code: '5400', name: 'Insurance', accountType: 'expense', taxCategory: 'Line 15' },
  { code: '5700', name: 'Legal & Professional', accountType: 'expense', taxCategory: 'Line 17' },
  { code: '5800', name: 'Office Expenses', accountType: 'expense', taxCategory: 'Line 18' },
  { code: '5900', name: 'Rent', accountType: 'expense', taxCategory: 'Line 20b' },
  { code: '6100', name: 'Supplies', accountType: 'expense', taxCategory: 'Line 22' },
  { code: '6300', name: 'Travel', accountType: 'expense', taxCategory: 'Line 24a' },
  { code: '6400', name: 'Meals', accountType: 'expense', taxCategory: 'Line 24b' },
  { code: '6500', name: 'Utilities', accountType: 'expense', taxCategory: 'Line 25' },
  { code: '6600', name: 'Software & Subscriptions', accountType: 'expense', taxCategory: 'Line 27a' },
  { code: '6700', name: 'Bank Fees', accountType: 'expense', taxCategory: 'Line 27a' },
];

const STUDENT_ACCOUNTS: { code: string; name: string; accountType: string; taxCategory?: string }[] = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1200', name: 'Checking / Debit Account', accountType: 'asset' },
  { code: '3000', name: "Owner's Equity", accountType: 'equity' },
  { code: '4000', name: 'Part-Time Job Income', accountType: 'revenue' },
  { code: '4100', name: 'Tutoring / Gig Income', accountType: 'revenue', taxCategory: 'Schedule C' },
  { code: '4200', name: 'Scholarship / Grant Income', accountType: 'revenue' },
  { code: '4300', name: 'Family Support / Allowance', accountType: 'revenue' },
  { code: '5000', name: 'Tuition & Fees', accountType: 'expense', taxCategory: '1098-T / T2202' },
  { code: '5100', name: 'Textbooks & Course Materials', accountType: 'expense' },
  { code: '5200', name: 'Rent / Housing', accountType: 'expense' },
  { code: '5300', name: 'Meal Plan / Groceries', accountType: 'expense' },
  { code: '5400', name: 'Transportation', accountType: 'expense' },
  { code: '5500', name: 'Phone & Software Subscriptions', accountType: 'expense' },
  { code: '5600', name: 'Student Loan Interest', accountType: 'expense', taxCategory: '1098-E' },
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const tenantConfig = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { businessType: true },
    });
    // TODO: also branch on AbTenantConfig.jurisdiction when a CA chart lands.
    const accounts = tenantConfig?.businessType === 'student' ? STUDENT_ACCOUNTS : US_ACCOUNTS;

    const created = await db.$transaction(
      accounts.map((a) =>
        db.abAccount.upsert({
          where: { tenantId_code: { tenantId, code: a.code } },
          update: { name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
          create: { tenantId, ...a },
        }),
      ),
    );

    return NextResponse.json({ success: true, data: { count: created.length } });
  } catch (err) {
    console.error('[agentbook-core/accounts/seed-jurisdiction] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
```

Replace with:

```ts
/**
 * Seed a default chart of accounts for the tenant's jurisdiction.
 *
 * Real, tested jurisdiction-pack charts — replaces the previously
 * duplicated, US-only inline account list (and the silent "always US"
 * fallback for every other jurisdiction, including ca and au) with the
 * same us/ca/au ChartOfAccountsTemplate packs already used elsewhere in
 * the tax engine. Re-runnable: upserts by (tenantId, code).
 *
 * businessType='student' gets a separate set — tuition/scholarship/gig
 * income isn't a Schedule-C/T2125/BAS business in any jurisdiction, and
 * there's no per-jurisdiction student chart pack to consume.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usChartOfAccounts } from '@agentbook/jurisdictions/us/chart-of-accounts';
import { caChartOfAccounts } from '@agentbook/jurisdictions/ca/chart-of-accounts';
import { auChartOfAccounts } from '@agentbook/jurisdictions/au/chart-of-accounts';
import type { ChartOfAccountsTemplate } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CHART_PROVIDERS: Record<string, ChartOfAccountsTemplate> = {
  us: usChartOfAccounts,
  ca: caChartOfAccounts,
  au: auChartOfAccounts,
};

const STUDENT_ACCOUNTS: { code: string; name: string; accountType: string; taxCategory?: string }[] = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1200', name: 'Checking / Debit Account', accountType: 'asset' },
  { code: '3000', name: "Owner's Equity", accountType: 'equity' },
  { code: '4000', name: 'Part-Time Job Income', accountType: 'revenue' },
  { code: '4100', name: 'Tutoring / Gig Income', accountType: 'revenue', taxCategory: 'Schedule C' },
  { code: '4200', name: 'Scholarship / Grant Income', accountType: 'revenue' },
  { code: '4300', name: 'Family Support / Allowance', accountType: 'revenue' },
  { code: '5000', name: 'Tuition & Fees', accountType: 'expense', taxCategory: '1098-T / T2202' },
  { code: '5100', name: 'Textbooks & Course Materials', accountType: 'expense' },
  { code: '5200', name: 'Rent / Housing', accountType: 'expense' },
  { code: '5300', name: 'Meal Plan / Groceries', accountType: 'expense' },
  { code: '5400', name: 'Transportation', accountType: 'expense' },
  { code: '5500', name: 'Phone & Software Subscriptions', accountType: 'expense' },
  { code: '5600', name: 'Student Loan Interest', accountType: 'expense', taxCategory: '1098-E' },
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const tenantConfig = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { businessType: true, jurisdiction: true },
    });

    let accounts: { code: string; name: string; accountType: string; taxCategory?: string }[];
    if (tenantConfig?.businessType === 'student') {
      accounts = STUDENT_ACCOUNTS;
    } else {
      const jurisdiction = tenantConfig?.jurisdiction || 'us';
      const provider = CHART_PROVIDERS[jurisdiction] ?? usChartOfAccounts;
      accounts = provider.getDefaultAccounts(tenantConfig?.businessType ?? 'freelancer').map((a) => ({
        code: a.code,
        name: a.name,
        accountType: a.type,
        taxCategory: a.taxCategory,
      }));
    }

    const created = await db.$transaction(
      accounts.map((a) =>
        db.abAccount.upsert({
          where: { tenantId_code: { tenantId, code: a.code } },
          update: { name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
          create: { tenantId, ...a },
        }),
      ),
    );

    return NextResponse.json({ success: true, data: { count: created.length } });
  } catch (err) {
    console.error('[agentbook-core/accounts/seed-jurisdiction] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/__tests__/route.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/__tests__/route.test.ts
git commit -m "fix(core): seed the real us/ca/au jurisdiction-pack chart of accounts, not always-US"
```

---

## Verification

- New test file: 6/6 passing (au/ca/us/fallback/student-regression/upsert-shape).
- Full test suite: `cd apps/web-next && npx vitest run` — no regressions beyond the same pre-existing/unrelated failures already established this session (8 known-unrelated failures per the PR-1 final review: a `yoga-layout` WASM crash in `agentbook-invoice-pdf.test.ts`, 2 MCP-connector wording mismatches, 3 unrelated-domain failures).
- Manual: run the onboarding "Set up chart of accounts" step for an AU test tenant (`sydney@agentbook.test`), then check `GET /api/v1/agentbook-core/accounts` (or the Ledger page's account list) shows GST Payable / Superannuation Payable / PAYG Withholding Payable — not Sales Tax Payable (the US-only account this tenant would have gotten before this fix).
- Deploy: commit → PR → CI → merge → build + deploy to production (same flow as Launch-gap PR-1) → spot-check that a fresh AU test tenant's seeded chart contains the real BAS-aligned accounts.
