import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const billSubFindMany = vi.fn();
const billSubUpdate = vi.fn();
const billEventDeleteMany = vi.fn();
const subscriptionsRetrieve = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: {
      findMany: (...a: unknown[]) => billSubFindMany(...a),
      update: (...a: unknown[]) => billSubUpdate(...a),
    },
    billEvent: { deleteMany: (...a: unknown[]) => billEventDeleteMany(...a) },
  },
}));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({ subscriptions: { retrieve: (...a: unknown[]) => subscriptionsRetrieve(...a) } }),
}));
vi.mock('@naap/billing', () => ({ invalidateAccount: vi.fn() }));

import { POST as resetQuotas } from '@/app/api/v1/agentbook-billing/cron/reset-quotas/route';
import { POST as cleanupEvents } from '@/app/api/v1/agentbook-billing/cron/cleanup-events/route';

beforeEach(() => {
  billSubFindMany.mockReset(); billSubUpdate.mockReset();
  billEventDeleteMany.mockReset(); subscriptionsRetrieve.mockReset();
  process.env.CRON_SECRET = 'shh';
});

function cronReq(headers: Record<string, string> = {}, query = ''): NextRequest {
  return new NextRequest(`http://x/cron${query}`, { method: 'POST', headers });
}

describe('cron reset-quotas', () => {
  it('rejects unauthorized', async () => {
    const r = await resetQuotas(cronReq());
    expect(r.status).toBe(401);
  });

  it('accepts x-vercel-cron header', async () => {
    billSubFindMany.mockResolvedValue([]);
    const r = await resetQuotas(cronReq({ 'x-vercel-cron': '1' }));
    expect(r.status).toBe(200);
  });

  it('accepts ?secret=<CRON_SECRET>', async () => {
    billSubFindMany.mockResolvedValue([]);
    const r = await resetQuotas(cronReq({}, '?secret=shh'));
    expect(r.status).toBe(200);
  });

  it('rolls forward stale Stripe subscription via subscriptions.retrieve', async () => {
    billSubFindMany.mockResolvedValue([
      { accountId: 't1', stripeSubscriptionId: 'sub_x', currentPeriodStart: new Date('2026-04-01'), currentPeriodEnd: new Date('2026-05-01') },
    ]);
    subscriptionsRetrieve.mockResolvedValue({
      status: 'active', current_period_start: 1717200000, current_period_end: 1719792000, cancel_at_period_end: false,
    });
    billSubUpdate.mockResolvedValue({});
    const r = await resetQuotas(cronReq({ 'x-vercel-cron': '1' }));
    const j = await r.json();
    expect(j.updated).toBe(1);
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_x');
  });

  it('rolls forward Free tier by adding one month', async () => {
    billSubFindMany.mockResolvedValue([
      { accountId: 't1', stripeSubscriptionId: null, currentPeriodStart: new Date('2026-04-01'), currentPeriodEnd: new Date('2026-05-01') },
    ]);
    billSubUpdate.mockResolvedValue({});
    const r = await resetQuotas(cronReq({ 'x-vercel-cron': '1' }));
    expect(r.status).toBe(200);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(billSubUpdate).toHaveBeenCalled();
  });
});

describe('cron cleanup-events', () => {
  it('rejects unauthorized', async () => {
    const r = await cleanupEvents(cronReq());
    expect(r.status).toBe(401);
  });

  it('deletes events older than 90 days', async () => {
    billEventDeleteMany.mockResolvedValue({ count: 42 });
    const r = await cleanupEvents(cronReq({ 'x-vercel-cron': '1' }));
    const j = await r.json();
    expect(j.deleted).toBe(42);
    expect(billEventDeleteMany).toHaveBeenCalled();
  });
});
