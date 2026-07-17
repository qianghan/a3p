import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const invoiceFindFirst = vi.fn();
const invoiceUpdate = vi.fn();
const journalLineFindMany = vi.fn();
const journalEntryCreate = vi.fn();
const clientUpdate = vi.fn();
const eventCreate = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abInvoice: {
      findFirst: (...a: unknown[]) => invoiceFindFirst(...a),
      update: (...a: unknown[]) => invoiceUpdate(...a),
    },
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
    abJournalEntry: { create: (...a: unknown[]) => journalEntryCreate(...a) },
    abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    $transaction: (cb: (tx: unknown) => unknown) => transaction(cb),
  },
}));

import { POST } from '@/app/api/v1/agentbook-invoice/invoices/[id]/void/route';

const txHandle = {
  abJournalEntry: { create: (...a: unknown[]) => journalEntryCreate(...a) },
  abInvoice: { update: (...a: unknown[]) => invoiceUpdate(...a) },
  abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
  abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
};

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-invoice/invoices/inv-1/void', { method: 'POST' });
}
const params = Promise.resolve({ id: 'inv-1' });

beforeEach(() => {
  resolveTenant.mockReset();
  invoiceFindFirst.mockReset();
  invoiceUpdate.mockReset();
  journalLineFindMany.mockReset();
  journalEntryCreate.mockReset();
  clientUpdate.mockReset();
  eventCreate.mockReset();
  transaction.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  invoiceUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'inv-1', status: data.status }));
  journalEntryCreate.mockResolvedValue({ id: 'je-void-1' });
  clientUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  transaction.mockImplementation(async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle));
});

describe('POST /api/v1/agentbook-invoice/invoices/:id/void — reversal correctness', () => {
  it('mirror-reverses a taxed (AU, 3-line) invoice\'s original journal entry line-for-line', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-AU-1',
      amountCents: 110000, taxCents: 10000, status: 'sent', journalEntryId: 'je-orig-1', payments: [],
    });
    journalLineFindMany.mockResolvedValue([
      { accountId: 'acct-ar', debitCents: 110000, creditCents: 0, description: 'AR - INV-AU-1' },
      { accountId: 'acct-rev', debitCents: 0, creditCents: 100000, description: 'Revenue - INV-AU-1' },
      { accountId: 'acct-gst', debitCents: 0, creditCents: 10000, description: 'GST Payable - INV-AU-1' },
    ]);

    const res = await POST(req(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // sourceType must NOT collide with the original creation entry's
    // (tenantId, 'invoice', invoice.id) tuple under the G-021 unique index.
    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceType: 'invoice_void',
        sourceId: 'inv-1',
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 110000, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 100000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-gst', debitCents: 10000, creditCents: 0, description: expect.any(String) },
          ],
        },
      }),
    }));

    // Net effect zeroes each account: AR reversal credit == original debit,
    // Revenue reversal debit == original credit, GST reversal debit == original credit.
    expect(clientUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { totalBilledCents: { decrement: 110000 } },
    }));
  });

  it('mirror-reverses an untaxed (US, 2-line) invoice correctly', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-2', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-US-1',
      amountCents: 100000, taxCents: 0, status: 'sent', journalEntryId: 'je-orig-2', payments: [],
    });
    journalLineFindMany.mockResolvedValue([
      { accountId: 'acct-ar', debitCents: 100000, creditCents: 0, description: 'AR - INV-US-1' },
      { accountId: 'acct-rev', debitCents: 0, creditCents: 100000, description: 'Revenue - INV-US-1' },
    ]);

    const res = await POST(req(), { params });
    expect(res.status).toBe(200);

    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 100000, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 100000, creditCents: 0, description: expect.any(String) },
          ],
        },
      }),
    }));
  });

  it('skips the reversal journal entry (but still voids) when the invoice never had one (e.g. a chat draft)', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-3', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-DRAFT-1',
      amountCents: 50000, taxCents: 0, status: 'draft', journalEntryId: null, payments: [],
    });

    const res = await POST(req(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(journalLineFindMany).not.toHaveBeenCalled();
    expect(journalEntryCreate).not.toHaveBeenCalled();
    expect(invoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'void' } }));
  });

  it('422s if journalEntryId is set but its lines cannot be found (data-integrity guard)', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-4', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-4',
      amountCents: 100000, taxCents: 0, status: 'sent', journalEntryId: 'je-missing', payments: [],
    });
    journalLineFindMany.mockResolvedValue([]);

    const res = await POST(req(), { params });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('still refuses to void an invoice with existing payments', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-5', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-5',
      amountCents: 100000, taxCents: 0, status: 'sent', journalEntryId: 'je-5',
      payments: [{ amountCents: 5000 }],
    });

    const res = await POST(req(), { params });
    expect(res.status).toBe(422);
    expect(journalLineFindMany).not.toHaveBeenCalled();
  });
});
