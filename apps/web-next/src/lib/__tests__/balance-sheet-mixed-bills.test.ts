// @vitest-environment node
/**
 * PR 3bc.5 guard — the balance sheet over a MIXED bill set built by the real
 * purchases engine: legacy at_payment (open / paid with paidCents 0 /
 * partial) and at_entry (open / partial / paid). Asserts the computed
 * numbers: A/P = derived at_payment outstanding + journal 2000, no bill
 * counted twice, and assets == liabilities + equity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

import { createFakeLedgerDb } from './fake-ledger-db';
import { postBill, payBill } from '../purchases';
import { computeBalanceSheet, type AccountTotals } from '../balance-sheet';
import { isUnpaid } from '../bill-amounts';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
let f: ReturnType<typeof createFakeLedgerDb>;

const line = (amountCents: number) => [{ description: 'Stuff', amountCents, categoryId: 'acct-meals', taxCode: 'GST' }];
const post = (mode: 'at_entry' | 'at_payment', amountCents: number) =>
  postBill(f.db as never, 't1', { vendorName: `${mode}-${amountCents}`, billDate: D('2026-11-02'), dueDate: D('2026-12-02'), lines: line(amountCents), postingMode: mode });

function totals(): AccountTotals[] {
  return f.state.accounts
    .filter((a) => a.tenantId === 't1' && a.isActive)
    .map((a) => {
      const ls = f.state.lines.filter((l) => l.accountId === a.id);
      return {
        accountId: a.id, code: a.code, name: a.code, accountType: a.accountType,
        debitCents: ls.reduce((s, l) => s + l.debitCents, 0), creditCents: ls.reduce((s, l) => s + l.creditCents, 0),
      };
    });
}

beforeEach(async () => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ id: 'cfg', userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD', accountingBasis: 'accrual' });
  f.state.accounts.push({ id: 'acct-equity', tenantId: 't1', code: '3000', accountType: 'equity', isActive: true });
  // Owner contribution: DR cash 100000 / CR equity 100000.
  f.state.entries.push({ id: 'je-cap', tenantId: 't1', date: D('2026-10-01'), sourceType: 'manual', sourceId: 'cap' });
  f.state.lines.push(
    { id: 'jl-c1', entryId: 'je-cap', accountId: 'acct-cash', debitCents: 100000, creditCents: 0 },
    { id: 'jl-c2', entryId: 'je-cap', accountId: 'acct-equity', debitCents: 0, creditCents: 100000 },
  );
  // Legacy at_payment bill paid before PR 3bc: status 'paid', paidCents 0, booked DR expense / CR cash.
  f.state.entries.push({ id: 'je-legacy', tenantId: 't1', date: D('2026-10-15'), sourceType: 'bill', sourceId: null });
  f.state.lines.push(
    { id: 'jl-l1', entryId: 'je-legacy', accountId: 'acct-meals', debitCents: 20000, creditCents: 0 },
    { id: 'jl-l2', entryId: 'je-legacy', accountId: 'acct-cash', debitCents: 0, creditCents: 20000 },
  );
  f.state.bills.push({ id: 'legacy-paid', tenantId: 't1', amountCents: 20000, paidCents: 0, status: 'paid', postingMode: 'at_payment', deletedAt: null });

  await post('at_payment', 10000); // legacy open                → derived 10000
  const p = await post('at_payment', 8000); // at_payment paid in full (partials are refused) → 0
  await payBill(f.db as never, 't1', p.bill.id, { date: D('2026-11-05') });
  await post('at_entry', 11000); // at_entry open                → journal 2000: 11000
  const e2 = await post('at_entry', 5000); // at_entry partial      → journal 2000: 3000
  await payBill(f.db as never, 't1', e2.bill.id, { amountCents: 2000, date: D('2026-11-06') });
  const e3 = await post('at_entry', 4000); // at_entry paid         → 0
  await payBill(f.db as never, 't1', e3.bill.id, { date: D('2026-11-07') });
});

describe('balance sheet — mixed legacy at_payment + at_entry bills', () => {
  it('A/P = derived at_payment outstanding (10000) + journal 2000 (14000); assets == liabilities + equity', () => {
    const unpaid = f.state.bills.filter((b) => isUnpaid(b as never));
    const sheet = computeBalanceSheet(totals(), unpaid as never, 'accrual');

    expect(sheet.accountsPayableOpenCents).toBe(10000);
    const ap = sheet.liabilities.filter((l) => l.code === '2000');
    expect(ap).toHaveLength(1); // merged, never two A/P lines
    expect(ap[0].balanceCents).toBe(24000);
    // Each unpaid bill counted exactly once: Σ outstanding = 10000+11000+3000.
    expect(ap[0].balanceCents).toBe(10000 + 11000 + 3000);

    const cash = sheet.assets.find((l) => l.code === '1000')!.balanceCents;
    expect(cash).toBe(100000 - 20000 - 8000 - 2000 - 4000);
    expect(sheet.totalAssetsCents).toBe(sheet.totalLiabilitiesCents + sheet.totalEquityCents);
    expect(sheet.balanced).toBe(true);
  });

  it('cash basis derives nothing and still balances', () => {
    const sheet = computeBalanceSheet(totals(), f.state.bills.filter((b) => isUnpaid(b as never)) as never, 'cash');
    expect(sheet.accountsPayableOpenCents).toBe(0);
    expect(sheet.liabilities.find((l) => l.code === '2000')!.balanceCents).toBe(14000);
    expect(sheet.balanced).toBe(true);
  });
});
