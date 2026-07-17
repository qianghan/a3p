import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const auditFn = vi.fn();
const computeInvoiceTax = vi.fn();

const clientFindFirst = vi.fn();
const clientUpdate = vi.fn();
const invoiceFindFirst = vi.fn();
const invoiceCreate = vi.fn();
const accountFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalEntryCreate = vi.fn();
const journalEntryUpdate = vi.fn();
const eventCreate = vi.fn();
const deferredRevenueCreate = vi.fn();
const salesTaxCreateMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@/lib/agentbook-audit', () => ({
  audit: (...a: unknown[]) => auditFn(...a),
}));

vi.mock('@/lib/agentbook-invoice-tax', () => ({
  computeInvoiceTax: (...a: unknown[]) => computeInvoiceTax(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abClient: {
      findFirst: (...a: unknown[]) => clientFindFirst(...a),
      update: (...a: unknown[]) => clientUpdate(...a),
    },
    abInvoice: {
      findFirst: (...a: unknown[]) => invoiceFindFirst(...a),
      create: (...a: unknown[]) => invoiceCreate(...a),
    },
    abAccount: {
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      findMany: (...a: unknown[]) => accountFindMany(...a),
    },
    abJournalEntry: {
      create: (...a: unknown[]) => journalEntryCreate(...a),
      update: (...a: unknown[]) => journalEntryUpdate(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    abDeferredRevenue: { create: (...a: unknown[]) => deferredRevenueCreate(...a) },
    abSalesTaxCollected: { createMany: (...a: unknown[]) => salesTaxCreateMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    $transaction: (cb: (tx: unknown) => unknown) => transaction(cb),
  },
}));

import { POST } from '@/app/api/v1/agentbook-invoice/invoices/route';

// The transaction callback receives `tx` — since all our mocked model
// methods are the same underlying vi.fn()s regardless of whether they're
// invoked via `db.x` or `tx.x`, we can hand the callback the same mocked
// prisma object.
const txHandle = {
  abJournalEntry: {
    create: (...a: unknown[]) => journalEntryCreate(...a),
    update: (...a: unknown[]) => journalEntryUpdate(...a),
  },
  abInvoice: { create: (...a: unknown[]) => invoiceCreate(...a) },
  abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
  abDeferredRevenue: { create: (...a: unknown[]) => deferredRevenueCreate(...a) },
  abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
  abSalesTaxCollected: { createMany: (...a: unknown[]) => salesTaxCreateMany(...a) },
};

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-invoice/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resolveTenant.mockReset();
  auditFn.mockReset();
  computeInvoiceTax.mockReset();
  clientFindFirst.mockReset();
  clientUpdate.mockReset();
  invoiceFindFirst.mockReset();
  invoiceCreate.mockReset();
  accountFindUnique.mockReset();
  accountFindMany.mockReset();
  journalEntryCreate.mockReset();
  journalEntryUpdate.mockReset();
  eventCreate.mockReset();
  deferredRevenueCreate.mockReset();
  salesTaxCreateMany.mockReset();
  tenantConfigFindUnique.mockReset();
  transaction.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  auditFn.mockResolvedValue(undefined);
  clientFindFirst.mockResolvedValue({ id: 'client-1', tenantId: 'tenant-1', name: 'Acme Co' });
  invoiceFindFirst.mockResolvedValue(null); // no prior invoice this year
  accountFindMany.mockResolvedValue([]);
  journalEntryCreate.mockResolvedValue({ id: 'je-1' });
  journalEntryUpdate.mockResolvedValue({});
  clientUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  deferredRevenueCreate.mockResolvedValue({});
  salesTaxCreateMany.mockResolvedValue({});
  tenantConfigFindUnique.mockResolvedValue(null);
  transaction.mockImplementation(async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle));

  // Default AR/Revenue accounts present; no liability accounts by default.
  accountFindUnique.mockImplementation(async ({ where }: { where: { tenantId_code: { code: string } } }) => {
    const code = where.tenantId_code.code;
    if (code === '1100') return { id: 'acct-ar', code: '1100' };
    if (code === '4000') return { id: 'acct-rev', code: '4000' };
    return null;
  });

  invoiceCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'inv-1',
    number: data.number,
    amountCents: data.amountCents,
    taxRate: data.taxRate,
    taxCents: data.taxCents,
    currency: data.currency,
    status: data.status,
    issuedDate: data.issuedDate,
    dueDate: data.dueDate,
  }));
});

const lineItemBody = (extra: Record<string, unknown> = {}) => ({
  clientId: 'client-1',
  lines: [{ description: 'Consulting', quantity: 1, rateCents: 100000 }], // $1000.00 subtotal
  ...extra,
});

describe('POST /api/v1/agentbook-invoice/invoices — sales tax wiring', () => {
  it('US tenant: 2-line journal entry, taxCents 0, no AbSalesTaxCollected write', async () => {
    computeInvoiceTax.mockResolvedValue({ taxRate: 0, taxCents: 0, components: [] });

    const res = await POST(req(lineItemBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(computeInvoiceTax).toHaveBeenCalledWith('tenant-1', 100000, null);

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 100000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 0, creditCents: 100000, description: expect.any(String) },
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
    expect(body.success).toBe(true);
  });

  it('AU tenant: 3-line journal entry (AR/Revenue/GST Payable), correct taxCents/taxRate, one AbSalesTaxCollected row', async () => {
    computeInvoiceTax.mockResolvedValue({
      taxRate: 0.10,
      taxCents: 10000,
      components: [{ type: 'GST', rate: 0.10, amountCents: 10000, accountCode: '2100' }],
    });
    accountFindMany.mockResolvedValue([{ id: 'acct-gst', code: '2100' }]);
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });

    const res = await POST(req(lineItemBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(accountFindMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: { in: ['2100'] } } });

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 110000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 0, creditCents: 100000, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-gst', debitCents: 0, creditCents: 10000, description: expect.any(String) },
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
        {
          tenantId: 'tenant-1',
          invoiceId: 'inv-1',
          jurisdiction: 'au',
          region: '',
          taxType: 'GST',
          rate: 0.10,
          amountCents: 10000,
        },
      ],
    });

    expect(clientUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { totalBilledCents: { increment: 110000 } },
    }));
    expect(body.success).toBe(true);
  });

  it('QC (Canadian) tenant: 4-line journal entry (AR/Revenue/GST/PST), two AbSalesTaxCollected rows', async () => {
    computeInvoiceTax.mockResolvedValue({
      taxRate: 0.14975,
      taxCents: 14975,
      components: [
        { type: 'GST', rate: 0.05, amountCents: 5000, accountCode: '2100' },
        { type: 'PST', rate: 0.09975, amountCents: 9975, accountCode: '2200' },
      ],
    });
    accountFindMany.mockResolvedValue([
      { id: 'acct-gst', code: '2100' },
      { id: 'acct-pst', code: '2200' },
    ]);
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC' });

    const res = await POST(req(lineItemBody()));
    const body = await res.json();

    expect(res.status).toBe(201);

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 114975, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 0, creditCents: 100000, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-gst', debitCents: 0, creditCents: 5000, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-pst', debitCents: 0, creditCents: 9975, description: expect.any(String) },
          ],
        },
      }),
    }));

    const createArgs = invoiceCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.amountCents).toBe(114975);
    expect(createArgs.data.taxCents).toBe(14975);

    expect(salesTaxCreateMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 'tenant-1', invoiceId: 'inv-1', jurisdiction: 'ca', region: 'QC', taxType: 'GST', rate: 0.05, amountCents: 5000 },
        { tenantId: 'tenant-1', invoiceId: 'inv-1', jurisdiction: 'ca', region: 'QC', taxType: 'PST', rate: 0.09975, amountCents: 9975 },
      ],
    });
    expect(body.success).toBe(true);
  });

  it('explicit taxRate in the request body overrides the jurisdiction default for an AU tenant', async () => {
    computeInvoiceTax.mockResolvedValue({
      taxRate: 0.07,
      taxCents: 7000,
      components: [{ type: 'GST', rate: 0.07, amountCents: 7000, accountCode: '2100' }],
    });
    accountFindMany.mockResolvedValue([{ id: 'acct-gst', code: '2100' }]);
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });

    const res = await POST(req(lineItemBody({ taxRate: 0.07 })));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(computeInvoiceTax).toHaveBeenCalledWith('tenant-1', 100000, 0.07);

    const createArgs = invoiceCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.amountCents).toBe(107000);
    expect(createArgs.data.taxCents).toBe(7000);
    expect(createArgs.data.taxRate).toBe(0.07);
    expect(body.success).toBe(true);
  });

  it('missing liability account returns 422 with no invoice/journal entry created', async () => {
    computeInvoiceTax.mockResolvedValue({
      taxRate: 0.10,
      taxCents: 10000,
      components: [{ type: 'GST', rate: 0.10, amountCents: 10000, accountCode: '2100' }],
    });
    accountFindMany.mockResolvedValue([]); // 2100 not seeded for this tenant

    const res = await POST(req(lineItemBody()));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/2100/);

    expect(transaction).not.toHaveBeenCalled();
    expect(journalEntryCreate).not.toHaveBeenCalled();
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(salesTaxCreateMany).not.toHaveBeenCalled();
  });
});
