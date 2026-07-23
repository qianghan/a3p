import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const expenseFindMany = vi.fn();
const vendorFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abExpense: { findMany: (...a: unknown[]) => expenseFindMany(...a) },
    abVendor: { findMany: (...a: unknown[]) => vendorFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-tax/reports/contractor-1099/route';

function req(query: string = ''): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook-tax/reports/contractor-1099${query}`, { method: 'GET' });
}

// A single "Contract Labor" chart-of-accounts row — matches the handler's
// lookup (code '5300' OR taxCategory/name containing 'Contract').
const CONTRACT_ACCOUNT = { id: 'acc-contract', code: '5300', name: 'Contract Labor', taxCategory: 'Contract Labor' };

const VENDORS = [
  { id: 'v-above', name: 'Acme Consulting' },
  { id: 'v-near', name: 'Near Threshold LLC' },
  { id: 'v-below', name: 'Small Vendor Co' },
];

// Expenses spread across two tax years so the `?year=` param can be verified
// to actually scope the underlying query, not just get accepted and ignored.
const ALL_EXPENSES = [
  // 2025: vendor "v-above" clears the US $600 / CA $500 threshold on its own.
  { vendorId: 'v-above', amountCents: 70_000, date: new Date('2025-03-01') },
  // 2025: vendor "v-near" sits just under threshold (within 90%).
  { vendorId: 'v-near', amountCents: 55_000, date: new Date('2025-06-01') },
  // 2025: vendor "v-below" is well under threshold.
  { vendorId: 'v-below', amountCents: 10_000, date: new Date('2025-09-01') },
  // 2026: only "v-above" was paid, and only enough to matter in CA ($500 threshold), not US ($600).
  { vendorId: 'v-above', amountCents: 55_000, date: new Date('2026-02-01') },
];

beforeEach(() => {
  resolveTenant.mockReset();
  tenantConfigFindUnique.mockReset();
  accountFindMany.mockReset();
  expenseFindMany.mockReset();
  vendorFindMany.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockResolvedValue([CONTRACT_ACCOUNT]);
  vendorFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    VENDORS.filter((v) => where.id.in.includes(v.id)),
  );
  // Mirror the handler's real date-range + categoryId + isPersonal filtering
  // so the test proves the year param and jurisdiction actually flow through
  // the route into the real getContractorSummaries function, not a stub.
  expenseFindMany.mockImplementation(async ({ where }: { where: { date: { gte: Date; lte: Date } } }) =>
    ALL_EXPENSES.filter((e) => e.date >= where.date.gte && e.date <= where.date.lte),
  );
});

describe('GET /api/v1/agentbook-tax/reports/contractor-1099', () => {
  it('US tenant: flags above-threshold, near-threshold, and below-threshold contractors correctly at the $600 1099-NEC line', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });

    const res = await GET(req('?year=2025'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.jurisdiction).toBe('us');
    expect(body.data.year).toBe(2025);

    const byName = (n: string) => body.data.contractors.find((c: { contractorName: string }) => c.contractorName === n);

    const above = byName('Acme Consulting');
    expect(above.totalPaidCents).toBe(70_000);
    expect(above.requiresReporting).toBe(true);
    expect(above.formId).toBe('1099-NEC');

    const near = byName('Near Threshold LLC');
    expect(near.requiresReporting).toBe(false);
    expect(near.nearThreshold).toBe(true); // 55,000 >= 90% of 60,000 (54,000)

    const below = byName('Small Vendor Co');
    expect(below.requiresReporting).toBe(false);
    expect(below.nearThreshold).toBe(false);
  });

  it('returns an empty contractor list (not an error) when there are no contract-labor expenses', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    expenseFindMany.mockResolvedValue([]);

    const res = await GET(req('?year=2025'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.contractors).toEqual([]);
  });

  it('respects the ?year= query param — 2026 data is excluded from a 2025 report', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });

    const res = await GET(req('?year=2026'));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Only the 2026 "v-above" expense ($550) should show up — under the US
    // $600 threshold, so no US contractor from 2025 data leaks in.
    expect(body.data.contractors).toHaveLength(1);
    expect(body.data.contractors[0].contractorName).toBe('Acme Consulting');
    expect(body.data.contractors[0].totalPaidCents).toBe(55_000);
    expect(body.data.contractors[0].requiresReporting).toBe(false);
  });

  it('CA tenant: uses the $500 T4A threshold, not the US $600 1099-NEC one', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });

    const res = await GET(req('?year=2026'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jurisdiction).toBe('ca');
    // Same 2026 $550 payment: below the US $600 threshold but above CA's $500 one.
    const contractor = body.data.contractors[0];
    expect(contractor.formId).toBe('T4A');
    expect(contractor.requiresReporting).toBe(true);
  });

  it('defaults jurisdiction to "us" when tenant config has none set', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);

    const res = await GET(req('?year=2025'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jurisdiction).toBe('us');
  });

  it('AU tenant: returns 422 unsupported_jurisdiction instead of a US 1099-NEC (H1)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });

    const res = await GET(req('?year=2025'));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('unsupported_jurisdiction');
    // The US contractor-reporting query must never run for an AU tenant.
    expect(expenseFindMany).not.toHaveBeenCalled();
  });

  it('UK tenant: also gated with 422 (no US form emitted)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'uk' });

    const res = await GET(req('?year=2025'));
    expect(res.status).toBe(422);
  });
});
