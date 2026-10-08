// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { POST } from '@/app/api/v1/agentbook-invoice/invoices/[id]/remind/route';

const remind = async (id: string, tenant = 't1') => {
  const res = await POST(tenantReq(`/api/v1/agentbook-invoice/invoices/${id}/remind`, tenant, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await json<{ success: boolean; data?: Record<string, unknown> }>(res) };
};
const writes = () => [...memDb.table('abInvoice').writes, ...memDb.table('abEvent').writes];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('POST /agentbook-invoice/invoices/:id/remind', () => {
  it('reminds a live overdue invoice: bumps lastRemindedAt and records the event', async () => {
    const { status, body } = await remind('inv1');
    expect(status).toBe(200);
    expect(body.data).toEqual({ tone: 'firm', daysOverdue: 19, balance: 150000, delivered: false });
    expect(memDb.table('abInvoice').rows.find((r) => r.id === 'inv1')?.lastRemindedAt).toEqual(NOW);
    expect(memDb.table('abEvent').rows).toHaveLength(1);
    expect(memDb.table('abEvent').rows[0]).toMatchObject({ tenantId: 't1', eventType: 'invoice.reminder_sent' });
  });

  it('a soft-deleted invoice is 404 and nothing is written', async () => {
    const { status, body } = await remind('inv4');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(writes()).toEqual([]);
    expect(memDb.table('abInvoice').rows.find((r) => r.id === 'inv4')?.lastRemindedAt).toBeUndefined();
  });

  it('is tenant-scoped: another tenant cannot remind t1’s invoice', async () => {
    expect((await remind('inv1', 't2')).status).toBe(404);
    expect(writes()).toEqual([]);
  });

  it('401 without a session', async () => {
    expect((await remind('inv1', 'none')).status).toBe(401);
    expect(writes()).toEqual([]);
  });
});
