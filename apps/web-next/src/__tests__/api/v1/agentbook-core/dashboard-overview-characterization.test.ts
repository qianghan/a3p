// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { GET } from '@/app/api/v1/agentbook-core/dashboard/overview/route';

interface Overview {
  success: boolean;
  data: {
    cashToday: number;
    monthMtd: unknown;
    monthPrev: unknown;
    isBrandNew: boolean;
    attention: Array<Record<string, unknown>>;
    nextMoments: unknown[];
    recurringOutflows: unknown[];
  };
}

const call = async (tenant: string) =>
  json<Overview>(await GET(tenantReq('/api/v1/agentbook-core/dashboard/overview', tenant)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

/**
 * Pinned against the code BEFORE the metrics were extracted into
 * lib/agentbook-dashboard-metrics.ts. Must stay green, unchanged, after it.
 */
describe('GET /dashboard/overview — characterization', () => {
  it('computes cash, month totals and the brand-new flag', async () => {
    const b = await call('t1');
    expect(b.success).toBe(true);
    expect(b.data.cashToday).toBe(460100);
    expect(b.data.monthMtd).toEqual({ revenueCents: 30000, expenseCents: 35400, netCents: -5400 });
    expect(b.data.monthPrev).toEqual({ revenueCents: 70000, expenseCents: 8000, netCents: 62000 });
    expect(b.data.isBrandNew).toBe(false);
  });

  it('ranks attention and builds next moments', async () => {
    const b = await call('t1');
    expect(b.data.attention.map((a) => a.id)).toEqual(['overdue:inv1', 'receipts']);
    expect(b.data.attention[0]).toMatchObject({
      severity: 'critical',
      title: 'Acme · 20 days overdue',
      amountCents: 180000,
      action: { postEndpoint: '/api/v1/agentbook-invoice/invoices/inv1/remind' },
    });
    expect(b.data.attention[1]).toMatchObject({ severity: 'info', title: '4 expenses missing receipts' });
    expect(b.data.nextMoments).toEqual([
      { kind: 'income', label: '💰 Beta $500 in 15d', amountCents: 50000, daysOut: 15, sourceId: 'inv2' },
    ]);
    expect(b.data.recurringOutflows).toEqual([]);
  });

  it('is tenant-scoped', async () => {
    const b = await call('t2');
    expect(b.data.cashToday).toBe(999);
    expect(b.data.attention.map((a) => a.id)).toEqual(['overdue:inv-x']);
  });

  it('a tenant with no data is brand new with empty slices', async () => {
    const b = await call('t3');
    expect(b.data).toMatchObject({ cashToday: 0, monthMtd: null, monthPrev: null, isBrandNew: true, attention: [], nextMoments: [] });
  });

  it('401 without a session', async () => {
    expect((await GET(tenantReq('/api/v1/agentbook-core/dashboard/overview', 'none'))).status).toBe(401);
  });
});
