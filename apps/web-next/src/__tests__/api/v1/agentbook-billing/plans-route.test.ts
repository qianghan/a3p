import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const billPlanFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    billPlan: { findMany: (...a: unknown[]) => billPlanFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-billing/plans/route';

const tenant = { tenantId: 'tenant-1' };

const US_PLANS = [
  { id: 'plan-free-us', code: 'free', region: 'us', currency: 'usd', priceCents: 0 },
  { id: 'plan-pro-us', code: 'pro', region: 'us', currency: 'usd', priceCents: 1900 },
];
const CA_PLANS = [
  { id: 'plan-free-ca', code: 'free', region: 'ca', currency: 'cad', priceCents: 0 },
  { id: 'plan-pro-ca', code: 'pro', region: 'ca', currency: 'cad', priceCents: 1900 },
];

beforeEach(() => {
  resolveTenant.mockReset();
  tenantConfigFindUnique.mockReset();
  billPlanFindMany.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

describe('GET /api/v1/agentbook-billing/plans (CA-4 region filtering)', () => {
  it('a CA tenant only sees the CA-region plans (CAD), not the US ones', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    billPlanFindMany.mockImplementation(({ where }: { where: { region: string } }) =>
      Promise.resolve(where.region === 'ca' ? CA_PLANS : US_PLANS),
    );

    const r = await GET(new NextRequest('http://x/plans'));
    const j = await r.json();

    expect(tenantConfigFindUnique).toHaveBeenCalledWith({ where: { userId: 'tenant-1' } });
    expect(billPlanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, region: 'ca' } }),
    );
    expect(j.plans).toEqual(CA_PLANS);
    expect(j.plans.every((p: { currency: string }) => p.currency === 'cad')).toBe(true);
  });

  it('a tenant with no configured jurisdiction defaults to us plans', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    billPlanFindMany.mockImplementation(({ where }: { where: { region: string } }) =>
      Promise.resolve(where.region === 'ca' ? CA_PLANS : US_PLANS),
    );

    const r = await GET(new NextRequest('http://x/plans'));
    const j = await r.json();

    expect(billPlanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, region: 'us' } }),
    );
    expect(j.plans).toEqual(US_PLANS);
  });
});
