import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const constructEvent = vi.fn();
const billEventCreate = vi.fn();
const billEventUpdate = vi.fn();
const billSubscriptionUpsert = vi.fn();
const billSubscriptionUpdate = vi.fn();
const billPlanFindFirst = vi.fn();
const planCacheInvalidate = vi.fn();
const salesRepProfileFindFirst = vi.fn();

vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
  }),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    billEvent: {
      create: (...a: unknown[]) => billEventCreate(...a),
      update: (...a: unknown[]) => billEventUpdate(...a),
    },
    billSubscription: {
      upsert: (...a: unknown[]) => billSubscriptionUpsert(...a),
      update: (...a: unknown[]) => billSubscriptionUpdate(...a),
    },
    billPlan: { findFirst: (...a: unknown[]) => billPlanFindFirst(...a) },
    salesRepProfile: { findFirst: (...a: unknown[]) => salesRepProfileFindFirst(...a) },
  },
}));

vi.mock('@naap/billing', () => ({
  invalidateAccount: (id: string) => planCacheInvalidate(id),
}));

import { POST } from '@/app/api/v1/agentbook/stripe-webhook/route';

beforeEach(() => {
  constructEvent.mockReset();
  billEventCreate.mockReset();
  billEventUpdate.mockReset();
  billSubscriptionUpsert.mockReset();
  billSubscriptionUpdate.mockReset();
  billPlanFindFirst.mockReset();
  planCacheInvalidate.mockReset();
  salesRepProfileFindFirst.mockReset();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
});

function req(body: string, sig: string | null): NextRequest {
  const headers = new Headers();
  if (sig) headers.set('stripe-signature', sig);
  return new NextRequest('http://x/api/v1/agentbook/stripe-webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('Stripe webhook', () => {
  it('returns 400 when signature header is missing', async () => {
    const r = await POST(req('{}', null));
    expect(r.status).toBe(400);
  });

  it('returns 400 when signature is invalid', async () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(400);
  });

  it('returns 200 + idempotent on duplicate event', async () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
    billEventCreate.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }));
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.idempotent).toBe(true);
    expect(billSubscriptionUpsert).not.toHaveBeenCalled();
  });

  it('applies customer.subscription.updated → upsert', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_x',
        customer: 'cus_x',
        status: 'active',
        items: { data: [{ price: { id: 'price_pro' } }] },
        current_period_start: 1700000000,
        current_period_end: 1702592000,
        cancel_at_period_end: false,
        metadata: { tenantId: 't1' },
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    billPlanFindFirst.mockResolvedValue({ id: 'plan-pro' });
    billSubscriptionUpsert.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpsert).toHaveBeenCalledTimes(1);
    expect(planCacheInvalidate).toHaveBeenCalledWith('t1');
  });

  it('applies customer.subscription.deleted → status canceled', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', customer: 'cus_x', metadata: { tenantId: 't1' } } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    billSubscriptionUpdate.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'canceled' }),
    }));
  });

  it('ignores unknown event types but still records BillEvent', async () => {
    constructEvent.mockReturnValue({ id: 'evt_4', type: 'random.thing', data: { object: {} } });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpsert).not.toHaveBeenCalled();
  });

  it('falls back to STRIPE_CONNECT_WEBHOOK_SECRET when the platform secret fails to verify', async () => {
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test';
    constructEvent
      .mockImplementationOnce(() => { throw new Error('bad sig for platform secret'); })
      .mockReturnValueOnce({ id: 'evt_5', type: 'account.updated', account: 'acct_123', data: { object: {} } });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    salesRepProfileFindFirst.mockResolvedValue(null);
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(constructEvent).toHaveBeenCalledTimes(2);
  });

  it('returns 400 when neither configured secret verifies', async () => {
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test';
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(400);
    expect(billEventCreate).not.toHaveBeenCalled();
  });
});
