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
const billAddOnPriceFindUnique = vi.fn();
const billAddOnFindUnique = vi.fn();
const billAddOnSubUpsert = vi.fn();
const billAddOnSubUpdate = vi.fn();
const abPaymentFindFirst = vi.fn();
const abPaymentCreate = vi.fn();
const abInvoiceFindFirst = vi.fn();
const abInvoiceUpdate = vi.fn();
const abAccountFindFirst = vi.fn();
const abJournalEntryCreate = vi.fn();
const abEventCreate = vi.fn();

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
    billAddOnPrice: { findUnique: (...a: unknown[]) => billAddOnPriceFindUnique(...a) },
    billAddOn: { findUnique: (...a: unknown[]) => billAddOnFindUnique(...a) },
    billAddOnSubscription: {
      upsert: (...a: unknown[]) => billAddOnSubUpsert(...a),
      update: (...a: unknown[]) => billAddOnSubUpdate(...a),
    },
    abPayment: {
      findFirst: (...a: unknown[]) => abPaymentFindFirst(...a),
      create: (...a: unknown[]) => abPaymentCreate(...a),
    },
    abInvoice: {
      findFirst: (...a: unknown[]) => abInvoiceFindFirst(...a),
      update: (...a: unknown[]) => abInvoiceUpdate(...a),
    },
    abAccount: { findFirst: (...a: unknown[]) => abAccountFindFirst(...a) },
    abJournalEntry: { create: (...a: unknown[]) => abJournalEntryCreate(...a) },
    abEvent: { create: (...a: unknown[]) => abEventCreate(...a) },
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
  billAddOnPriceFindUnique.mockReset();
  billAddOnFindUnique.mockReset();
  billAddOnSubUpsert.mockReset();
  billAddOnSubUpdate.mockReset();
  abPaymentFindFirst.mockReset();
  abPaymentCreate.mockReset();
  abInvoiceFindFirst.mockReset();
  abInvoiceUpdate.mockReset();
  abAccountFindFirst.mockReset();
  abJournalEntryCreate.mockReset();
  abEventCreate.mockReset();
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

  it('syncs a BillAddOnSubscription when the event has addOnCode metadata, without touching BillPlan', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_addon_1',
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_addon_1', status: 'active', customer: 'cus_1',
        metadata: { tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits', priceId: 'price-1' },
        items: { data: [{ price: { id: 'price_addon_std' } }] },
        current_period_start: 1700000000, current_period_end: 1702592000,
        cancel_at_period_end: false,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    billAddOnPriceFindUnique.mockResolvedValue({ id: 'price-1', addOnId: 'addon-1' });
    billAddOnSubUpsert.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billAddOnSubUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId_addOnId: { accountId: 'tenant-1', addOnId: 'addon-1' } },
    }));
    expect(billPlanFindFirst).not.toHaveBeenCalled();
    expect(billSubscriptionUpsert).not.toHaveBeenCalled();
  });

  it('marks a BillAddOnSubscription canceled on subscription.deleted with addOnCode metadata', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_addon_2',
      type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_addon_1', customer: 'cus_1',
        metadata: { tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits' },
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    billAddOnFindUnique.mockResolvedValue({ id: 'addon-1' });
    billAddOnSubUpdate.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billAddOnSubUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'canceled' }),
    }));
    expect(billSubscriptionUpdate).not.toHaveBeenCalled();
  });

  it('checkout.session.completed creates a balanced journal entry using account codes 1000/1100', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_1', tenantId: 'tenant-1' },
        payment_intent: 'pi_123',
        amount_total: 50000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue(null); // no existing payment for this PaymentIntent
    abInvoiceFindFirst.mockResolvedValue({ id: 'inv_1', number: 'INV-2026-0001', amountCents: 50000, status: 'sent' });
    abPaymentCreate.mockResolvedValue({});
    abInvoiceUpdate.mockResolvedValue({});
    abAccountFindFirst.mockImplementation(async ({ where }: { where: { code: string } }) => {
      if (where.code === '1000') return { id: 'acct-cash' };
      if (where.code === '1100') return { id: 'acct-ar' };
      return null;
    });
    abJournalEntryCreate.mockResolvedValue({});
    abEventCreate.mockResolvedValue({});

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abAccountFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: '1000' } });
    expect(abAccountFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: '1100' } });
    expect(abJournalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-cash', debitCents: 50000, creditCents: 0 },
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 50000 },
          ],
        },
      }),
    }));
  });

  it('checkout.session.completed records the payment even when accounts 1000/1100 are missing (best-effort, non-fatal)', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_2',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_2', tenantId: 'tenant-2' },
        payment_intent: 'pi_456',
        amount_total: 25000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue(null);
    abInvoiceFindFirst.mockResolvedValue({ id: 'inv_2', number: 'INV-2026-0002', amountCents: 25000, status: 'sent' });
    abPaymentCreate.mockResolvedValue({});
    abInvoiceUpdate.mockResolvedValue({});
    abAccountFindFirst.mockResolvedValue(null); // chart of accounts not seeded for this tenant
    abEventCreate.mockResolvedValue({});

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abJournalEntryCreate).not.toHaveBeenCalled();
    expect(abPaymentCreate).toHaveBeenCalledTimes(1);
    expect(abInvoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'paid' },
    }));
  });

  it('checkout.session.completed is idempotent on a retried PaymentIntent', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_3',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_3', tenantId: 'tenant-3' },
        payment_intent: 'pi_789',
        amount_total: 10000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue({ id: 'existing-payment' }); // already recorded

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abPaymentCreate).not.toHaveBeenCalled();
    expect(abInvoiceFindFirst).not.toHaveBeenCalled();
  });
});
