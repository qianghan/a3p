import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const invoiceUpdateMany = vi.fn();
const invoiceFindFirst = vi.fn();
const invoiceCreate = vi.fn();
const recurringFindMany = vi.fn();
const recurringUpdate = vi.fn();
const clientFindFirst = vi.fn();
const clientUpdate = vi.fn();
const accountFindFirst = vi.fn();
const accountFindMany = vi.fn();
const journalEntryCreate = vi.fn();
const journalEntryUpdate = vi.fn();
const eventCreate = vi.fn();
const salesTaxCreateMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abInvoice: {
      updateMany: (...a: unknown[]) => invoiceUpdateMany(...a),
      findFirst: (...a: unknown[]) => invoiceFindFirst(...a),
      create: (...a: unknown[]) => invoiceCreate(...a),
    },
    abRecurringInvoice: {
      findMany: (...a: unknown[]) => recurringFindMany(...a),
      update: (...a: unknown[]) => recurringUpdate(...a),
    },
    abClient: {
      findFirst: (...a: unknown[]) => clientFindFirst(...a),
      update: (...a: unknown[]) => clientUpdate(...a),
    },
    abAccount: {
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      findMany: (...a: unknown[]) => accountFindMany(...a),
    },
    abJournalEntry: {
      create: (...a: unknown[]) => journalEntryCreate(...a),
      update: (...a: unknown[]) => journalEntryUpdate(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abSalesTaxCollected: { createMany: (...a: unknown[]) => salesTaxCreateMany(...a) },
    $transaction: (cb: (tx: unknown) => unknown) => transaction(cb),
  },
}));

const computeInvoiceTax = vi.fn();
vi.mock('@/lib/agentbook-invoice-tax', () => ({
  computeInvoiceTax: (...a: unknown[]) => computeInvoiceTax(...a),
}));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/recurring-invoices/route';

// Same rationale as the invoice-creation route test: the transaction
// callback receives `tx`, and since all mocked model methods are the same
// underlying vi.fn()s regardless of whether invoked via `db.x` or `tx.x`,
// we hand the callback the same mocked prisma object.
const txHandle = {
  abJournalEntry: {
    create: (...a: unknown[]) => journalEntryCreate(...a),
    update: (...a: unknown[]) => journalEntryUpdate(...a),
  },
  abInvoice: { create: (...a: unknown[]) => invoiceCreate(...a) },
  abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
  abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
  abSalesTaxCollected: { createMany: (...a: unknown[]) => salesTaxCreateMany(...a) },
};

function req(): NextRequest {
  return new NextRequest('http://x/cron/recurring-invoices');
}

const templateLines = [{ description: 'Consulting', quantity: 1, rateCents: 100000 }];

function makeRecurringItem(overrides: Record<string, unknown>) {
  return {
    id: 'ri-default',
    tenantId: 'tenant-default',
    clientId: 'client-default',
    currency: 'USD',
    frequency: 'monthly',
    nextDue: new Date('2026-07-01T00:00:00Z'),
    endDate: null,
    status: 'active',
    templateLines,
    totalCents: 100000,
    daysToPay: 30,
    autoSend: true,
    lastGenerated: null,
    generatedCount: 0,
    ...overrides,
  };
}

const auAccounts: Record<string, { id: string; code: string }> = {
  '1100': { id: 'acct-ar-au', code: '1100' },
  '4000': { id: 'acct-rev-au', code: '4000' },
  '2100': { id: 'acct-gst-au', code: '2100' },
};
const usAccounts: Record<string, { id: string; code: string }> = {
  '1100': { id: 'acct-ar-us', code: '1100' },
  '4000': { id: 'acct-rev-us', code: '4000' },
};
// tenant-missing has AR/Revenue seeded but NOT the GST liability account (2100).
const missingAccounts: Record<string, { id: string; code: string }> = {
  '1100': { id: 'acct-ar-missing', code: '1100' },
  '4000': { id: 'acct-rev-missing', code: '4000' },
};

const accountsByTenant: Record<string, Record<string, { id: string; code: string }>> = {
  'tenant-au': auAccounts,
  'tenant-us': usAccounts,
  'tenant-missing': missingAccounts,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;

  invoiceUpdateMany.mockResolvedValue({ count: 0 });
  invoiceFindFirst.mockResolvedValue(null); // no prior invoice this year
  recurringUpdate.mockResolvedValue({});
  clientFindFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) => ({
    id: where.id,
    tenantId: where.tenantId,
    name: `Client ${where.id}`,
  }));
  clientUpdate.mockResolvedValue({});
  journalEntryCreate.mockResolvedValue({ id: 'je-1' });
  journalEntryUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  salesTaxCreateMany.mockResolvedValue({});
  transaction.mockImplementation(async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle));

  invoiceCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `inv-${data.tenantId}`,
    ...data,
  }));

  accountFindFirst.mockImplementation(async ({ where }: { where: { tenantId: string; code: string } }) => {
    const accounts = accountsByTenant[where.tenantId] || {};
    return accounts[where.code] || null;
  });
  accountFindMany.mockImplementation(async ({ where }: { where: { tenantId: string; code: { in: string[] } } }) => {
    const accounts = accountsByTenant[where.tenantId] || {};
    return where.code.in.map((code) => accounts[code]).filter(Boolean);
  });

  tenantConfigFindUnique.mockImplementation(async ({ where }: { where: { userId: string } }) => {
    if (where.userId === 'tenant-au') return { jurisdiction: 'au', region: '' };
    if (where.userId === 'tenant-us') return { jurisdiction: 'us', region: '' };
    if (where.userId === 'tenant-missing') return { jurisdiction: 'au', region: '' };
    return null;
  });

  computeInvoiceTax.mockImplementation(async (tenantId: string) => {
    if (tenantId === 'tenant-au' || tenantId === 'tenant-missing') {
      return { taxRate: 0.10, taxCents: 10000, components: [{ type: 'GST', rate: 0.10, amountCents: 10000, accountCode: '2100' }] };
    }
    return { taxRate: 0, taxCents: 0, components: [] };
  });
});

describe('GET /cron/recurring-invoices — sales tax wiring', () => {
  it('returns 401 when CRON_SECRET is set and the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'real-secret';
    recurringFindMany.mockResolvedValue([]);
    const res = await GET(req());
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('AU tenant: generates a 3-line journal entry (AR/Revenue/GST Payable) with correct taxCents', async () => {
    const item = makeRecurringItem({ id: 'ri-au', tenantId: 'tenant-au', clientId: 'client-au', totalCents: 100000, currency: 'AUD' });
    recurringFindMany.mockResolvedValue([item]);

    const res = await GET(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.generated).toBe(1);
    expect(computeInvoiceTax).toHaveBeenCalledWith('tenant-au', 100000);

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-au', accountId: 'acct-ar-au', debitCents: 110000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-au', accountId: 'acct-rev-au', debitCents: 0, creditCents: 100000, description: expect.any(String) },
            { tenantId: 'tenant-au', accountId: 'acct-gst-au', debitCents: 0, creditCents: 10000, description: expect.any(String) },
          ],
        },
      }),
    }));

    const createArgs = invoiceCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.amountCents).toBe(110000);
    expect(createArgs.data.taxCents).toBe(10000);
    expect(createArgs.data.taxRate).toBe(0.10);

    expect(salesTaxCreateMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 'tenant-au', invoiceId: 'inv-tenant-au', jurisdiction: 'au', region: '', taxType: 'GST', rate: 0.10, amountCents: 10000 },
      ],
    });

    expect(clientUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { totalBilledCents: { increment: 110000 } },
    }));
  });

  it('US tenant: unaffected — 2-line journal entry, taxCents 0, no AbSalesTaxCollected write', async () => {
    const item = makeRecurringItem({ id: 'ri-us', tenantId: 'tenant-us', clientId: 'client-us', totalCents: 100000, currency: 'USD' });
    recurringFindMany.mockResolvedValue([item]);

    const res = await GET(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.generated).toBe(1);
    expect(computeInvoiceTax).toHaveBeenCalledWith('tenant-us', 100000);

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-us', accountId: 'acct-ar-us', debitCents: 100000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-us', accountId: 'acct-rev-us', debitCents: 0, creditCents: 100000, description: expect.any(String) },
          ],
        },
      }),
    }));

    const createArgs = invoiceCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.amountCents).toBe(100000);
    expect(createArgs.data.taxCents).toBe(0);
    expect(createArgs.data.taxRate).toBeNull();

    expect(salesTaxCreateMany).not.toHaveBeenCalled();
    expect(clientUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { totalBilledCents: { increment: 100000 } },
    }));
  });

  it('skips an item whose tenant is missing the required liability account, logs a warning, and still processes other due items', async () => {
    const missingItem = makeRecurringItem({ id: 'ri-missing', tenantId: 'tenant-missing', clientId: 'client-missing', totalCents: 100000, currency: 'AUD' });
    const okItem = makeRecurringItem({ id: 'ri-us', tenantId: 'tenant-us', clientId: 'client-us', totalCents: 50000, currency: 'USD' });
    recurringFindMany.mockResolvedValue([missingItem, okItem]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.checked).toBe(2);
    // Only the US item (unaffected by the missing GST account) was generated.
    expect(json.generated).toBe(1);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ri-missing'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing tax liability account'));

    // The skipped item never reached journal-entry/invoice creation, but the
    // other due item in the same run did.
    expect(invoiceCreate).toHaveBeenCalledTimes(1);
    expect(invoiceCreate.mock.calls[0][0].data.tenantId).toBe('tenant-us');
    expect(recurringUpdate).toHaveBeenCalledTimes(1);
    expect(recurringUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ri-us' } }));

    warnSpy.mockRestore();
  });
});
