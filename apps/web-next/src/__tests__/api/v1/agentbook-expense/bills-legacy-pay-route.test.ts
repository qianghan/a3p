// @vitest-environment node
/**
 * PR 3bc.4 — the legacy bill routes, wired through lib/purchases.
 * Asserts journal lines (cents per account) the REAL route handlers write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => {
  const { memDb } = await import('@/__tests__/helpers/mem-db');
  return { prisma: new Proxy(memDb, { get: (t, p) => (p === 'featureFlag' ? { findUnique: async () => flagRow } : (t as never)[p]) }) };
});
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const ensureChartOfAccounts = vi.fn(async () => ({ seeded: false, count: 0 }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: (...a: unknown[]) => ensureChartOfAccounts(...(a as [])),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

let flagRow: { enabled: boolean } | null = null;

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { POST as CREATE } from '@/app/api/v1/agentbook-expense/bills/route';
import { POST, DELETE } from '@/app/api/v1/agentbook-expense/bills/[id]/route';

const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-ap', tenantId: 't1', code: '2000', name: 'AP', accountType: 'liability', isActive: true },
  { id: 'acc-gst', tenantId: 't1', code: '2100', name: 'GST', accountType: 'liability', isActive: true },
  { id: 'acc-phone', tenantId: 't1', code: '5300', name: 'Phone', accountType: 'expense', isActive: true },
  { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
];
const legacy = (over: Row = {}): Row => ({
  id: 'b1', tenantId: 't1', vendorName: 'Telstra', description: 'Phone', amountCents: 8800, categoryCode: '5300',
  dueDate: new Date('2026-11-30T00:00:00Z'), status: 'open', paidDate: null, journalEntryId: null, paidCents: 0,
  postingMode: 'at_payment', revision: 0, deletedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'), ...over,
});
function seed(bills: Row[], extra: Row = {}) {
  memDb.reset(
    { abAccount: ACCOUNTS, abBill: bills, abBillPayment: [], abBillLine: [], abFiscalPeriod: [], abTenantConfig: [{ userId: 't1', currency: 'AUD', jurisdiction: 'au', region: 'NSW', gstRegistered: true, accountingBasis: 'accrual' }], ...extra },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']], abBill: [['id']], abBillPayment: [['id']] } },
  );
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function pay(id: string, body: Row = {}, tenant = 't1') {
  const res = await POST(tenantReq(`/api/v1/agentbook-expense/bills/${id}?action=pay`, tenant, { method: 'POST', body }), ctx(id));
  return { status: res.status, body: await json<{ success: boolean; data: Row; code?: string }>(res) };
}
async function del(id: string) {
  const res = await DELETE(tenantReq(`/api/v1/agentbook-expense/bills/${id}`, 't1', { method: 'DELETE' }), ctx(id));
  return { status: res.status, body: await json<{ success: boolean; data: Row; code?: string }>(res) };
}
function linesOf(entryId: unknown): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const l of memDb.table('abJournalLine').rows.filter((x) => x.entryId === entryId)) {
    out[l.accountId as string] = [l.debitCents as number, l.creditCents as number];
  }
  return out;
}
const entries = () => memDb.table('abJournalEntry').rows;

beforeEach(() => {
  flagRow = null;
  ensureChartOfAccounts.mockClear();
});

describe('POST bills/[id]?action=pay — legacy at_payment', () => {
  it('posts DR expense / CR 1000 keyed bill/<payment id>, dated paidDate', async () => {
    seed([legacy()]);
    const r = await pay('b1', { paidDate: '2026-11-15T00:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'paid', paidCents: 8800 });
    const payment = memDb.table('abBillPayment').rows[0];
    const e = entries()[0];
    expect(e).toMatchObject({ sourceType: 'bill', sourceId: payment.id });
    expect((e.date as Date).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(linesOf(e.id)).toEqual({ 'acc-phone': [8800, 0], 'acc-cash': [0, 8800] });
    expect(r.body.data.journalEntryId).toBe(e.id);
  });

  it('no category books 6999 suspense', async () => {
    seed([legacy({ categoryCode: null })]);
    await pay('b1');
    expect(linesOf(entries()[0].id)).toEqual({ 'acc-susp': [8800, 0], 'acc-cash': [0, 8800] });
  });

  it('missing account → 422 and the bill is NOT marked paid', async () => {
    seed([legacy({ categoryCode: '5999' })]);
    const r = await pay('b1');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ledger_account_missing');
    expect(ensureChartOfAccounts).toHaveBeenCalledWith('t1');
    expect(memDb.table('abBill').rows[0]).toMatchObject({ status: 'open', journalEntryId: null });
    expect(entries()).toHaveLength(0);
  });

  it('closed period → 422, nothing written', async () => {
    seed([legacy()], { abFiscalPeriod: [{ tenantId: 't1', year: 2026, month: 11, status: 'closed' }] });
    const r = await pay('b1', { paidDate: '2026-11-15T00:00:00Z' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('period_closed');
    expect(memDb.table('abBill').rows[0].status).toBe('open');
  });

  it('already paid (legacy paidCents 0) → 409; cross-tenant → 404', async () => {
    seed([legacy({ status: 'paid' })]);
    expect((await pay('b1')).status).toBe(409);
    seed([legacy()]);
    expect((await pay('b1', {}, 't2')).status).toBe(404);
  });
});

describe('DELETE bills/[id]', () => {
  it('refuses a paid bill (its payment entry would stay live)', async () => {
    seed([legacy({ status: 'paid', journalEntryId: 'je-old' })]);
    const r = await del('b1');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('bill_has_payments');
    expect(memDb.table('abBill').rows[0].status).toBe('paid');
  });

  it('cancels an unpaid legacy bill without posting', async () => {
    seed([legacy()]);
    const r = await del('b1');
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
    expect(entries()).toHaveLength(0);
  });
});

describe('POST bills — flag purchases_at_entry', () => {
  const body = { vendorName: 'Officeworks', amountCents: 11000, categoryCode: '5300', dueDate: '2026-12-01', billDate: '2026-11-02', taxCode: 'GST' };
  it('off: legacy create, no ledger impact', async () => {
    seed([]);
    const res = await CREATE(tenantReq('/api/v1/agentbook-expense/bills', 't1', { method: 'POST', body }));
    expect(res.status).toBe(201);
    expect(memDb.table('abBill').rows[0].postingMode ?? 'at_payment').toBe('at_payment');
    expect(entries()).toHaveLength(0);
  });
  it('on (accrual): posts DR 5300 / DR 2100 / CR 2000 at billDate', async () => {
    flagRow = { enabled: true };
    seed([]);
    const res = await CREATE(tenantReq('/api/v1/agentbook-expense/bills', 't1', { method: 'POST', body }));
    expect(res.status).toBe(201);
    const bill = memDb.table('abBill').rows[0];
    expect(bill.postingMode).toBe('at_entry');
    const e = entries().find((x) => x.sourceType === 'bill' && x.sourceId === bill.id)!;
    expect(linesOf(e.id)).toEqual({ 'acc-phone': [10000, 0], 'acc-gst': [1000, 0], 'acc-ap': [0, 11000] });
  });
  it('on, cash-basis tenant: stays at_payment', async () => {
    flagRow = { enabled: true };
    seed([], { abTenantConfig: [{ userId: 't1', currency: 'AUD', accountingBasis: 'cash' }] });
    await CREATE(tenantReq('/api/v1/agentbook-expense/bills', 't1', { method: 'POST', body }));
    expect(entries()).toHaveLength(0);
  });
});
