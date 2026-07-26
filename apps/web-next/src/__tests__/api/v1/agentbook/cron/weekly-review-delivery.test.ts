import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const findManyTenants = vi.fn();
const expenseAggregate = vi.fn();
const invoiceAggregate = vi.fn();
const invoiceCount = vi.fn();
const paymentAggregate = vi.fn();
const expenseCount = vi.fn();
const eventCreate = vi.fn();
const sendToAllChannels = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findMany: (...a: unknown[]) => findManyTenants(...a) },
    abExpense: { aggregate: (...a: unknown[]) => expenseAggregate(...a), count: (...a: unknown[]) => expenseCount(...a) },
    abInvoice: { aggregate: (...a: unknown[]) => invoiceAggregate(...a), count: (...a: unknown[]) => invoiceCount(...a) },
    abPayment: { aggregate: (...a: unknown[]) => paymentAggregate(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));
vi.mock('@/lib/agentbook-chat-adapter', () => ({ sendToAllChannels: (...a: unknown[]) => sendToAllChannels(...a) }));
vi.mock('@/lib/jurisdiction-currency', () => ({ formatCurrencyCents: (c: number, cur?: string) => `${cur || 'USD'} ${(c / 100).toFixed(0)}` }));
vi.mock('@/lib/logger', () => ({ reportError: vi.fn() }));

import { GET } from '@/app/api/v1/agentbook/cron/weekly-review/route';

function req(): NextRequest { return new NextRequest('http://x/api/v1/agentbook/cron/weekly-review'); }

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockResolvedValue({});
  invoiceCount.mockResolvedValue(0);
  expenseCount.mockResolvedValue(0);
  sendToAllChannels.mockResolvedValue([]);
  // default aggregates → zero
  const zero = { _sum: { amountCents: 0 }, _count: 0 };
  expenseAggregate.mockResolvedValue(zero);
  invoiceAggregate.mockResolvedValue(zero);
  paymentAggregate.mockResolvedValue(zero);
});

describe('weekly-review cron — delivery', () => {
  it('SENDS the summary to a tenant with activity (currency-formatted)', async () => {
    findManyTenants.mockResolvedValue([{ userId: 't1', currency: 'AUD' }]);
    expenseAggregate.mockResolvedValue({ _sum: { amountCents: 484000 }, _count: 5 });
    invoiceAggregate.mockResolvedValue({ _sum: { amountCents: 1000000 }, _count: 2 });
    paymentAggregate.mockResolvedValue({ _sum: { amountCents: 500000 }, _count: 1 });

    const res = await GET(req());
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.delivered).toBe(1);
    expect(sendToAllChannels).toHaveBeenCalledTimes(1);
    const [tenantId, msg] = sendToAllChannels.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(msg).toMatch(/week in review/i);
    expect(msg).toContain('AUD'); // used the tenant currency, not hardcoded $
  });

  it('does NOT spam a tenant with zero activity that week', async () => {
    findManyTenants.mockResolvedValue([{ userId: 't2', currency: 'USD' }]);
    // all aggregates + counts default to 0
    const res = await GET(req());
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.delivered).toBe(0);
    expect(sendToAllChannels).not.toHaveBeenCalled();
    expect(eventCreate).toHaveBeenCalled(); // event still emitted for history
  });

  it('still counts the tenant and keeps going if one delivery throws', async () => {
    findManyTenants.mockResolvedValue([{ userId: 't3', currency: 'USD' }]);
    invoiceCount.mockResolvedValue(3); // overdue → activity
    sendToAllChannels.mockRejectedValue(new Error('telegram down'));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.delivered).toBe(0);
  });
});
