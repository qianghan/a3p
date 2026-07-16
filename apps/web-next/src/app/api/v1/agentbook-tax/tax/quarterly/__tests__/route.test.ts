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
