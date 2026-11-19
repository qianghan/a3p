// @vitest-environment node
/**
 * PR 2b.8 — imported drafts (CSV / CC statement / bank) are pending_review and
 * unbooked; confirm is where they reach the ledger, so confirm resolves tax
 * through resolveExpenseTax (vendor default → registrant default) and books
 * the recoverable split.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { POST as CONFIRM } from '@/app/api/v1/agentbook-expense/expenses/[id]/confirm/route';

const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-gst', tenantId: 't1', code: '2100', name: 'GST/HST Payable', accountType: 'liability', isActive: true },
  { id: 'acc-office', tenantId: 't1', code: '5200', name: 'Office Supplies', accountType: 'expense', isActive: true },
  { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
];

function seed(cfg: Row, expense: Row, vendors: Row[] = []) {
  memDb.reset(
    {
      abAccount: ACCOUNTS,
      abTenantConfig: [{ id: 'cfg', userId: 't1', ...cfg }],
      abVendor: vendors,
      abFiscalPeriod: [],
      abExpense: [{ id: 'e1', tenantId: 't1', amountCents: 11000, taxAmountCents: 0, date: new Date('2026-06-10'), description: 'OFFICEWORKS 123', status: 'pending_review', isPersonal: false, journalEntryId: null, deletedAt: null, taxCode: null, recoverableTaxCents: 0, source: 'cc_statement', ...expense }],
    },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']] } },
  );
}
async function confirm(body: Row = {}) {
  const res = await CONFIRM(tenantReq('/api/v1/agentbook-expense/expenses/e1/confirm', 't1', { method: 'POST', body }), { params: Promise.resolve({ id: 'e1' }) });
  return { status: res.status, body: await json<{ success: boolean; data: Row }>(res) };
}
function lines(): Record<string, [number, number]> {
  const exp = memDb.table('abExpense').rows.find((e) => e.id === 'e1')!;
  const out: Record<string, [number, number]> = {};
  for (const l of memDb.table('abJournalLine').rows.filter((x) => x.entryId === exp.journalEntryId)) out[l.accountId] = [l.debitCents, l.creditCents];
  return out;
}
const row = () => memDb.table('abExpense').rows.find((e) => e.id === 'e1')!;

describe('confirm an imported draft', () => {
  beforeEach(() => seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: true }, { categoryId: 'acc-office' }));

  it('AU registrant: untyped import gets the registrant default GST and books 3 lines', async () => {
    const r = await confirm();
    expect(r.status).toBe(200);
    expect(row()).toMatchObject({ status: 'confirmed', taxCode: 'GST', taxAmountCents: 1000, recoverableTaxCents: 1000 });
    expect(lines()).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
  });

  it("the vendor's default code wins over the registrant default (FRE → 2 lines)", async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: true }, { categoryId: 'acc-office', vendorId: 'v1' }, [{ id: 'v1', tenantId: 't1', name: 'Fresh', normalizedName: 'fresh', defaultTaxCode: 'FRE' }]);
    await confirm();
    expect(row()).toMatchObject({ taxCode: 'FRE', recoverableTaxCents: 0 });
    expect(lines()).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
  });

  it('an already-typed draft keeps its code; an amount change on confirm recomputes the split', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: true }, { categoryId: 'acc-office', taxCode: 'GST', recoverableTaxCents: 1000, taxAmountCents: 1000 });
    await confirm({ amountCents: 22000 });
    expect(row()).toMatchObject({ amountCents: 22000, taxCode: 'GST', recoverableTaxCents: 2000 });
    expect(lines()).toEqual({ 'acc-office': [20000, 0], 'acc-gst': [2000, 0], 'acc-cash': [0, 22000] });
  });

  it('US / unregistered: unchanged 2-line gross, untyped', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: false }, { categoryId: 'acc-office' });
    await confirm();
    expect(row().taxCode ?? null).toBeNull();
    expect(lines()).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
  });

  it('no category: confirmed but not booked (unchanged)', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: true }, { categoryId: null });
    await confirm();
    expect(row()).toMatchObject({ status: 'confirmed', journalEntryId: null });
  });
});
