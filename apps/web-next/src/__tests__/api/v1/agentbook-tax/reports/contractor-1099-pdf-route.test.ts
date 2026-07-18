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

import { GET } from '@/app/api/v1/agentbook-tax/reports/contractor-1099/pdf/route';

function req(query: string = ''): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook-tax/reports/contractor-1099/pdf${query}`, { method: 'GET' });
}

// Mirrors contractor-1099-route.test.ts's fixtures exactly, since this route
// calls the same real getContractorSummaries function against the same
// mocked db shape.
const CONTRACT_ACCOUNT = { id: 'acc-contract', code: '5300', name: 'Contract Labor', taxCategory: 'Contract Labor' };

const VENDORS = [
  { id: 'v-above', name: 'Acme Consulting' },
  { id: 'v-near', name: 'Near Threshold LLC' },
  { id: 'v-below', name: 'Small Vendor Co' },
];

const ALL_EXPENSES = [
  // 2025: vendor "v-above" clears the CA $500 threshold on its own.
  { vendorId: 'v-above', amountCents: 70_000, date: new Date('2025-03-01') },
  // 2025: vendor "v-near" sits just under threshold (within 90%).
  { vendorId: 'v-near', amountCents: 45_000, date: new Date('2025-06-01') },
  // 2025: vendor "v-below" is well under threshold.
  { vendorId: 'v-below', amountCents: 10_000, date: new Date('2025-09-01') },
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
  expenseFindMany.mockImplementation(async ({ where }: { where: { date: { gte: Date; lte: Date } } }) =>
    ALL_EXPENSES.filter((e) => e.date >= where.date.gte && e.date <= where.date.lte),
  );
});

describe('GET /api/v1/agentbook-tax/reports/contractor-1099/pdf', () => {
  it('CA tenant with an eligible (above-threshold) contractor gets a real T4A PDF', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', companyName: 'Acme Consulting' });

    const res = await GET(req('?year=2025&contractorName=Acme%20Consulting'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 8).toString('utf8')).toMatch(/^%PDF-/);
  });

  it('US tenant gets a 400 (T4A generation is CA-only)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });

    const res = await GET(req('?year=2025&contractorName=Acme%20Consulting'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('a contractor under the reporting threshold gets a 400', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });

    const res = await GET(req('?year=2025&contractorName=Near%20Threshold%20LLC'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('an unknown contractor name gets a 404', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });

    const res = await GET(req('?year=2025&contractorName=Nonexistent%20Vendor'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
  });

  it('missing contractorName param gets a 400', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });

    const res = await GET(req('?year=2025'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });
});
