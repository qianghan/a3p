import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const invoiceFindFirst = vi.fn();
const salesTaxFindMany = vi.fn();
const accountFindUnique = vi.fn();
const accountFindMany = vi.fn();
const creditNoteFindFirst = vi.fn();
const journalEntryCreate = vi.fn();
const creditNoteCreate = vi.fn();
const clientUpdate = vi.fn();
const eventCreate = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abInvoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a) },
    abSalesTaxCollected: { findMany: (...a: unknown[]) => salesTaxFindMany(...a) },
    abAccount: {
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      findMany: (...a: unknown[]) => accountFindMany(...a),
    },
    abCreditNote: {
      findFirst: (...a: unknown[]) => creditNoteFindFirst(...a),
      create: (...a: unknown[]) => creditNoteCreate(...a),
    },
    abJournalEntry: { create: (...a: unknown[]) => journalEntryCreate(...a) },
    abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    $transaction: (cb: (tx: unknown) => unknown) => transaction(cb),
  },
}));

import { POST } from '@/app/api/v1/agentbook-invoice/credit-notes/route';

const txHandle = {
  abJournalEntry: { create: (...a: unknown[]) => journalEntryCreate(...a) },
  abCreditNote: { create: (...a: unknown[]) => creditNoteCreate(...a) },
  abClient: { update: (...a: unknown[]) => clientUpdate(...a) },
  abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
};

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-invoice/credit-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resolveTenant.mockReset();
  invoiceFindFirst.mockReset();
  salesTaxFindMany.mockReset();
  accountFindUnique.mockReset();
  accountFindMany.mockReset();
  creditNoteFindFirst.mockReset();
  journalEntryCreate.mockReset();
  creditNoteCreate.mockReset();
  clientUpdate.mockReset();
  eventCreate.mockReset();
  transaction.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  creditNoteFindFirst.mockResolvedValue(null);
  accountFindMany.mockResolvedValue([]);
  journalEntryCreate.mockResolvedValue({ id: 'je-cn-1' });
  creditNoteCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cn-1', ...data }));
  clientUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  transaction.mockImplementation(async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle));

  accountFindUnique.mockImplementation(async ({ where }: { where: { tenantId_code: { code: string } } }) => {
    const code = where.tenantId_code.code;
    if (code === '1100') return { id: 'acct-ar', code: '1100' };
    if (code === '4000') return { id: 'acct-rev', code: '4000' };
    return null;
  });
});

describe('POST /api/v1/agentbook-invoice/credit-notes — tax-aware reversal', () => {
  it('full credit against an untaxed invoice: unchanged 2-line Revenue/AR entry', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-1',
      amountCents: 100000, taxCents: 0, status: 'sent', payments: [],
    });

    const res = await POST(req({ invoiceId: 'inv-1', amountCents: 100000, reason: 'refund' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(salesTaxFindMany).not.toHaveBeenCalled();
    expect(journalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 100000, creditCents: 0, description: expect.any(String) },
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 100000, description: expect.any(String) },
          ],
        },
      }),
    }));
  });

  it('full credit against a taxed AU invoice: prorates between Revenue and GST Payable, balances exactly', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-2', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-AU-1',
      amountCents: 110000, taxCents: 10000, status: 'sent', payments: [],
    });
    salesTaxFindMany.mockResolvedValue([
      { taxType: 'GST', amountCents: 10000, rate: 0.10 },
    ]);
    accountFindMany.mockResolvedValue([{ id: 'acct-gst', code: '2100' }]);

    const res = await POST(req({ invoiceId: 'inv-2', amountCents: 110000, reason: 'full refund' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(accountFindMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: { in: ['2100'] } } });

    const call = journalEntryCreate.mock.calls[0][0] as { data: { lines: { create: { accountId: string; debitCents: number; creditCents: number }[] } } };
    const lines = call.data.lines.create;
    // Revenue 100000 + GST 10000 == AR 110000. Full credit clears everything.
    expect(lines).toEqual([
      { tenantId: 'tenant-1', accountId: 'acct-rev', debitCents: 100000, creditCents: 0, description: expect.any(String) },
      { tenantId: 'tenant-1', accountId: 'acct-gst', debitCents: 10000, creditCents: 0, description: expect.any(String) },
      { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 110000, description: expect.any(String) },
    ]);
    const totalDebits = lines.reduce((s, l) => s + l.debitCents, 0);
    const totalCredits = lines.reduce((s, l) => s + l.creditCents, 0);
    expect(totalDebits).toBe(totalCredits);
  });

  it('partial credit against a taxed QC invoice: prorates Revenue/GST/PST proportionally and balances', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-3', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-QC-1',
      amountCents: 11498, taxCents: 1498, status: 'sent', payments: [],
    });
    salesTaxFindMany.mockResolvedValue([
      { taxType: 'GST', amountCents: 500, rate: 0.05 },
      { taxType: 'PST', amountCents: 998, rate: 0.09975 },
    ]);
    accountFindMany.mockResolvedValue([
      { id: 'acct-gst', code: '2100' },
      { id: 'acct-pst', code: '2200' },
    ]);

    // Credit half the invoice: 5749 of 11498.
    const res = await POST(req({ invoiceId: 'inv-3', amountCents: 5749, reason: 'partial refund' }));
    expect(res.status).toBe(201);

    const call = journalEntryCreate.mock.calls[0][0] as { data: { lines: { create: { accountId: string; debitCents: number; creditCents: number }[] } } };
    const lines = call.data.lines.create;
    const totalDebits = lines.reduce((s, l) => s + l.debitCents, 0);
    const totalCredits = lines.reduce((s, l) => s + l.creditCents, 0);
    expect(totalDebits).toBe(5749);
    expect(totalCredits).toBe(5749);
    expect(totalDebits).toBe(totalCredits);

    const arLine = lines.find((l) => l.accountId === 'acct-ar');
    expect(arLine?.creditCents).toBe(5749);
  });

  it('422s when a taxed invoice\'s liability account is missing (no DB write)', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-4', tenantId: 'tenant-1', clientId: 'client-1', number: 'INV-4',
      amountCents: 110000, taxCents: 10000, status: 'sent', payments: [],
    });
    salesTaxFindMany.mockResolvedValue([{ taxType: 'GST', amountCents: 10000, rate: 0.10 }]);
    accountFindMany.mockResolvedValue([]); // 2100 not seeded

    const res = await POST(req({ invoiceId: 'inv-4', amountCents: 110000, reason: 'refund' }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(journalEntryCreate).not.toHaveBeenCalled();
    expect(creditNoteCreate).not.toHaveBeenCalled();
  });
});
