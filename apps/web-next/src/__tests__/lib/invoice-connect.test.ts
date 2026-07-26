import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const cfgFindUnique = vi.fn();
const cfgUpdate = vi.fn();
const userFindUnique = vi.fn();
const invoiceFindFirst = vi.fn();
const invoiceUpdate = vi.fn();
const accountsCreate = vi.fn();
const accountsRetrieve = vi.fn();
const accountLinksCreate = vi.fn();
const checkoutCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => cfgFindUnique(...a), update: (...a: unknown[]) => cfgUpdate(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    abInvoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a), update: (...a: unknown[]) => invoiceUpdate(...a) },
  },
}));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    accounts: { create: (...a: unknown[]) => accountsCreate(...a), retrieve: (...a: unknown[]) => accountsRetrieve(...a) },
    accountLinks: { create: (...a: unknown[]) => accountLinksCreate(...a) },
    checkout: { sessions: { create: (...a: unknown[]) => checkoutCreate(...a) } },
  }),
}));

import { getOrCreateInvoiceAccount, createInvoicePayLink, InvoicePayLinkError } from '@/lib/invoice-connect';

beforeEach(() => {
  vi.clearAllMocks();
  cfgUpdate.mockResolvedValue({});
  invoiceUpdate.mockResolvedValue({});
  userFindUnique.mockResolvedValue({ email: 'me@x.com' });
});

describe('getOrCreateInvoiceAccount', () => {
  it('returns the existing Connect account without creating a new one', async () => {
    cfgFindUnique.mockResolvedValue({ stripeInvoiceAccountId: 'acct_existing', jurisdiction: 'au' });
    const id = await getOrCreateInvoiceAccount('t1');
    expect(id).toBe('acct_existing');
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  it('creates an Express account in the tenant country and stores it', async () => {
    cfgFindUnique.mockResolvedValue({ stripeInvoiceAccountId: null, jurisdiction: 'ca' });
    accountsCreate.mockResolvedValue({ id: 'acct_new' });
    const id = await getOrCreateInvoiceAccount('t1');
    expect(id).toBe('acct_new');
    expect(accountsCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'express', country: 'CA' }));
    expect(cfgUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { stripeInvoiceAccountId: 'acct_new' } }));
  });
});

describe('createInvoicePayLink', () => {
  const invoice = { id: 'inv1', tenantId: 't1', number: 'INV-1', amountCents: 100000, currency: 'AUD', status: 'sent', payments: [] };

  it('refuses when the tenant has not connected/onboarded a payout account', async () => {
    invoiceFindFirst.mockResolvedValue(invoice);
    cfgFindUnique.mockResolvedValue({ stripeInvoiceAccountId: null, stripeInvoicePayoutsEnabled: false });
    await expect(createInvoicePayLink('inv1', 't1', 'https://x')).rejects.toThrow(InvoicePayLinkError);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('refuses an already-paid invoice', async () => {
    invoiceFindFirst.mockResolvedValue({ ...invoice, status: 'paid' });
    await expect(createInvoicePayLink('inv1', 't1', 'https://x')).rejects.toThrow(/already paid/i);
  });

  it('creates a checkout that routes funds to the freelancer and sets paymentUrl', async () => {
    invoiceFindFirst.mockResolvedValue(invoice);
    cfgFindUnique.mockResolvedValue({ stripeInvoiceAccountId: 'acct_free', stripeInvoicePayoutsEnabled: true });
    checkoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/abc' });

    const url = await createInvoicePayLink('inv1', 't1', 'https://app');
    expect(url).toBe('https://checkout.stripe.com/abc');
    const arg = checkoutCreate.mock.calls[0][0];
    expect(arg.payment_intent_data.transfer_data.destination).toBe('acct_free'); // money → freelancer
    expect(arg.line_items[0].price_data.currency).toBe('aud');
    expect(arg.line_items[0].price_data.unit_amount).toBe(100000);
    expect(arg.metadata).toMatchObject({ invoiceId: 'inv1', tenantId: 't1', kind: 'invoice_payment' });
    expect(invoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentUrl: url } }));
  });

  it('subtracts prior partial payments from the amount charged', async () => {
    invoiceFindFirst.mockResolvedValue({ ...invoice, payments: [{ amountCents: 30000 }] });
    cfgFindUnique.mockResolvedValue({ stripeInvoiceAccountId: 'acct_free', stripeInvoicePayoutsEnabled: true });
    checkoutCreate.mockResolvedValue({ url: 'https://checkout/x' });
    await createInvoicePayLink('inv1', 't1', 'https://app');
    expect(checkoutCreate.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(70000);
  });
});
