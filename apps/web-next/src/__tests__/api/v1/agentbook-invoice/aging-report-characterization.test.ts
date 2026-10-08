// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { GET } from '@/app/api/v1/agentbook-invoice/aging-report/route';

interface Aging {
  data: {
    buckets: Record<string, Array<Record<string, unknown>>>;
    totals: Record<string, number>;
    totalOutstandingCents: number;
    asOfDate: string;
  };
}
const call = async (tenant: string) =>
  json<Aging>(await GET(tenantReq('/api/v1/agentbook-invoice/aging-report', tenant)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('GET /agentbook-invoice/aging-report — characterization', () => {
  it('buckets open balances (amount − payments) by days overdue', async () => {
    const b = await call('t1');
    expect(b.data.totalOutstandingCents).toBe(200000);
    expect(b.data.totals).toEqual({ current: 50000, '1-30': 150000, '31-60': 0, '61-90': 0, '90+': 0 });
    expect(b.data.buckets['1-30']).toHaveLength(1);
    expect(b.data.buckets['1-30'][0]).toMatchObject({
      invoiceId: 'inv1', number: 'INV-1', clientName: 'Acme', amountCents: 180000, balanceDueCents: 150000, daysOverdue: 19,
    });
    expect(b.data.asOfDate).toBe(NOW.toISOString());
  });

  it('is tenant-scoped', async () => {
    const b = await call('t2');
    expect(b.data.totalOutstandingCents).toBe(999000);
    expect(b.data.buckets['31-60'].map((e) => e.invoiceId)).toEqual(['inv-x']);
  });
});
