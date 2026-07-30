/**
 * Admin ledger-health diagnostic.
 *
 * Journal posting silently no-ops when a tenant has no active Cash (1000) /
 * A/R (1100) account, so such a tenant's P&L and tax estimate quietly omit real
 * money. This endpoint finds them across all tenants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantFindMany = vi.fn();
const accountFindMany = vi.fn();
const requireAdminMock = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findMany: (...a: unknown[]) => tenantFindMany(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
  },
}));
vi.mock('@/lib/admin-guard', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}));

import { GET } from '@/app/api/v1/agentbook-core/admin/ledger-health/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-core/admin/ledger-health');
}

const T = (userId: string) => ({
  userId, jurisdiction: 'us', businessType: 'freelancer', createdAt: new Date('2026-01-01'),
});

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } }); // authorized
});

describe('GET /admin/ledger-health', () => {
  it('is admin-gated — a non-admin gets the guard response, and no data is read', async () => {
    const denied = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    requireAdminMock.mockResolvedValue({ response: denied });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(tenantFindMany).not.toHaveBeenCalled();
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it('reports every tenant healthy when all have active 1000 + 1100', async () => {
    tenantFindMany.mockResolvedValue([T('t1'), T('t2')]);
    accountFindMany.mockResolvedValue([
      { tenantId: 't1', code: '1000', isActive: true }, { tenantId: 't1', code: '1100', isActive: true },
      { tenantId: 't2', code: '1000', isActive: true }, { tenantId: 't2', code: '1100', isActive: true },
    ]);

    const json = await (await GET(req())).json();
    expect(json.data.totalTenants).toBe(2);
    expect(json.data.healthy).toBe(2);
    expect(json.data.unhealthyCount).toBe(0);
    expect(json.data.unhealthy).toEqual([]);
  });

  it('flags a tenant with NO accounts at all — cannot book anything', async () => {
    tenantFindMany.mockResolvedValue([T('t1'), T('broken')]);
    accountFindMany.mockResolvedValue([
      { tenantId: 't1', code: '1000', isActive: true }, { tenantId: 't1', code: '1100', isActive: true },
    ]);

    const json = await (await GET(req())).json();
    expect(json.data.unhealthyCount).toBe(1);
    expect(json.data.cannotBookAtAll).toBe(1);
    expect(json.data.unhealthy[0].tenantId).toBe('broken');
    expect(json.data.unhealthy[0].missing.sort()).toEqual(['1000', '1100']);
  });

  it('distinguishes missing-A/R-only (invoices affected) from missing-Cash (nothing books)', async () => {
    tenantFindMany.mockResolvedValue([T('no-ar'), T('no-cash')]);
    accountFindMany.mockResolvedValue([
      { tenantId: 'no-ar', code: '1000', isActive: true },   // cash only
      { tenantId: 'no-cash', code: '1100', isActive: true },  // AR only
    ]);

    const json = await (await GET(req())).json();
    expect(json.data.unhealthyCount).toBe(2);
    expect(json.data.cannotBookAtAll).toBe(1); // only the one missing 1000
    const noAr = json.data.unhealthy.find((u: { tenantId: string }) => u.tenantId === 'no-ar');
    expect(noAr.missing).toEqual(['1100']);
  });

  it('treats an INACTIVE account as missing (the posting paths require an active one)', async () => {
    tenantFindMany.mockResolvedValue([T('t1')]);
    accountFindMany.mockResolvedValue([
      { tenantId: 't1', code: '1000', isActive: false },
      { tenantId: 't1', code: '1100', isActive: true },
    ]);

    const json = await (await GET(req())).json();
    expect(json.data.unhealthyCount).toBe(1);
    expect(json.data.unhealthy[0].missing).toEqual(['1000']);
  });

  it('queries only the two relevant codes, once, rather than per tenant', async () => {
    tenantFindMany.mockResolvedValue([T('t1'), T('t2'), T('t3')]);
    accountFindMany.mockResolvedValue([]);
    await GET(req());
    expect(accountFindMany).toHaveBeenCalledTimes(1);
    expect(accountFindMany.mock.calls[0][0].where.code.in.sort()).toEqual(['1000', '1100']);
  });
});
