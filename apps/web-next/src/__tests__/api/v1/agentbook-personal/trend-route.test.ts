import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const requirePersonalInsightsAddon = vi.fn();
const accountFindMany = vi.fn();
const transactionFindMany = vi.fn();

vi.mock('@/lib/agentbook-personal-insights/guard', () => ({
  requirePersonalInsightsAddon: (...a: unknown[]) => requirePersonalInsightsAddon(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: {
      findMany: (...a: unknown[]) => accountFindMany(...a),
    },
    abPersonalTransaction: {
      findMany: (...a: unknown[]) => transactionFindMany(...a),
    },
  },
}));

import { GET } from '@/app/api/v1/agentbook-personal/trend/route';

function getReq(): NextRequest {
  return new NextRequest('http://x/trend');
}

beforeEach(() => {
  requirePersonalInsightsAddon.mockReset();
  accountFindMany.mockReset();
  transactionFindMany.mockReset();
  accountFindMany.mockResolvedValue([]);
  transactionFindMany.mockResolvedValue([]);
});

describe('GET /api/v1/agentbook-personal/trend', () => {
  it('returns 402 without the personal_insights add-on and never queries account data', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const res = await GET(getReq());
    expect(res.status).toBe(402);
    expect(accountFindMany).not.toHaveBeenCalled();
    expect(transactionFindMany).not.toHaveBeenCalled();
  });

  it('returns 200 with trend data when the tenant has the add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({ tenantId: 'tenant-1' });
    accountFindMany.mockResolvedValueOnce([
      {
        id: 'a1',
        tenantId: 'tenant-1',
        name: 'Checking',
        type: 'checking',
        balanceCents: 5_000,
        currency: 'USD',
        isAsset: true,
        plaidAccountId: null,
        archived: false,
        createdAt: new Date(2020, 0, 1),
        updatedAt: new Date(2020, 0, 1),
      },
    ]);
    transactionFindMany.mockResolvedValueOnce([]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(12);
    // Fetches the full account list (not pre-filtered to archived:false) so
    // computeNetWorthTrend itself is responsible for excluding archived accounts.
    expect(accountFindMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
  });
});
