/**
 * PR 2a — ledger shapes.
 *
 * 2a.1 pins TODAY's behaviour for the untyped shapes (2-line, 3-line with a tax
 * liability, split) so the ledger-writer extraction is provably neutral.
 * 2a.3 pins the registrant shape `DR category(net+nonrecoverable) | DR 2100(recoverable) | CR 1000(gross)`
 * for a TYPED expense (taxCode set): edit amount, change category, delete and
 * uncategorised→categorised reclass must each stay balanced with exact P&L figures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ fake: null as any }));
vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import {
  repostExpenseJournalEntry,
  reverseExpenseJournalEntry,
  backfillExpenseJournalEntry,
  ExpenseLedgerShapeError,
} from '../agentbook-expense-ledger';

const JAN = new Date('2026-01-15T12:00:00.000Z');
const EXPENSE_ACCOUNTS = new Set(['acct-meals', 'acct-travel', 'acct-suspense']);
beforeEach(() => { h.fake = createFakeLedgerDb(); });

/** P&L expense total = net debit on expense accounts across every entry. */
const pnlExpenseCents = () =>
  Object.entries(h.fake.netByAccount() as Record<string, number>)
    .filter(([a]) => EXPENSE_ACCOUNTS.has(a))
    .reduce((s, [, v]) => s + v, 0);

function expectEveryEntryBalanced() {
  for (const e of h.fake.state.entries) {
    const ls = h.fake.state.lines.filter((l: any) => l.entryId === e.id);
    const dr = ls.reduce((s: number, l: any) => s + l.debitCents, 0);
    const cr = ls.reduce((s: number, l: any) => s + l.creditCents, 0);
    expect(dr, `entry ${e.id} (${e.sourceType}) balanced`).toBe(cr);
  }
}

const THREE_LINE_TAX_LIABILITY = [
  { accountId: 'acct-meals', debitCents: 4200, creditCents: 0 },
  { accountId: 'acct-cash', debitCents: 0, creditCents: 4000 },
  { accountId: 'acct-tax', debitCents: 0, creditCents: 200 },
];
const SPLIT = [
  { accountId: 'acct-meals', debitCents: 2000, creditCents: 0 },
  { accountId: 'acct-travel', debitCents: 2200, creditCents: 0 },
  { accountId: 'acct-cash', debitCents: 0, creditCents: 4200 },
];

describe('2a.1 — untyped shapes keep today\'s behaviour', () => {
  it('2-line: amount edit reposts at the new amount', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].amountCents = 5000;
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5000, 'acct-cash': -5000 });
    expectEveryEntryBalanced();
  });

  it('2-line: category change moves the debit', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].categoryId = 'acct-travel';
    await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db, { categoryChanged: true });
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
  });

  it('2-line: delete reverses to zero', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    expect((await reverseExpenseJournalEntry('t1', 'exp-1')).reversed).toBe(true);
    expect(h.fake.netByAccount()).toEqual({});
  });

  it.each([['3-line with tax liability', THREE_LINE_TAX_LIABILITY], ['split', SPLIT]])(
    '%s: amount edit and category change are refused (ShapeError), nothing written',
    async (_n, lines) => {
      h.fake.seedEntryExpense({ amountCents: 4200, date: JAN, lines });
      h.fake.state.expenses[0].amountCents = 5000;
      await expect(repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).rejects.toBeInstanceOf(ExpenseLedgerShapeError);
      h.fake.state.expenses[0].amountCents = 4200;
      h.fake.state.expenses[0].categoryId = 'acct-travel';
      await expect(
        repostExpenseJournalEntry('t1', 'exp-1', h.fake.db, { categoryChanged: true }),
      ).rejects.toBeInstanceOf(ExpenseLedgerShapeError);
      expect(h.fake.state.entries).toHaveLength(1);
    },
  );

  it.each([['3-line with tax liability', THREE_LINE_TAX_LIABILITY], ['split', SPLIT]])(
    '%s: delete mirrors every line back to zero',
    async (_n, lines) => {
      h.fake.seedEntryExpense({ amountCents: 4200, date: JAN, lines });
      expect((await reverseExpenseJournalEntry('t1', 'exp-1')).reversed).toBe(true);
      expect(h.fake.netByAccount()).toEqual({});
      expectEveryEntryBalanced();
    },
  );

  it('reclassify from suspense: a 2-line suspense posting moves onto the category in place', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-suspense' });
    h.fake.state.expenses[0].categoryId = 'acct-meals';
    await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('reclassify from suspense: a split with a suspense part is left alone', async () => {
    h.fake.seedEntryExpense({
      amountCents: 4200, date: JAN,
      lines: [
        { accountId: 'acct-suspense', debitCents: 2000, creditCents: 0 },
        { accountId: 'acct-travel', debitCents: 2200, creditCents: 0 },
        { accountId: 'acct-cash', debitCents: 0, creditCents: 4200 },
      ],
    });
    await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 2000, 'acct-travel': 2200, 'acct-cash': -4200 });
  });
});

/** $110.00 gross incl. $10.00 recoverable GST: DR meals 10000 | DR 2100 1000 | CR cash 11000. */
function seedRegistrant(debitAccountId = 'acct-meals', expense: Record<string, unknown> = {}) {
  return h.fake.seedEntryExpense({
    amountCents: 11000, date: JAN,
    lines: [
      { accountId: debitAccountId, debitCents: 10000, creditCents: 0 },
      { accountId: 'acct-gst', debitCents: 1000, creditCents: 0, description: 'GST' },
      { accountId: 'acct-cash', debitCents: 0, creditCents: 11000, description: 'Payment' },
    ],
    expense: { taxCode: 'GST', taxAmountCents: 1000, recoverableTaxCents: 1000, categoryId: debitAccountId, ...expense },
  });
}

describe('2a.3 — registrant shape DR category | DR 2100 | CR 1000 (typed expense)', () => {
  it('amount edit recomputes the category/2100 split from amountCents and recoverableTaxCents', async () => {
    seedRegistrant();
    Object.assign(h.fake.state.expenses[0], { amountCents: 22000, taxAmountCents: 2000, recoverableTaxCents: 2000 });
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 20000, 'acct-gst': 2000, 'acct-cash': -22000 });
    expect(pnlExpenseCents()).toBe(20000);
    expectEveryEntryBalanced();
  });

  it('a non-recoverable portion stays in the category (net + non-recoverable)', async () => {
    seedRegistrant();
    // Meals: half the GST recoverable -> category carries 10000 + 500.
    Object.assign(h.fake.state.expenses[0], { recoverableTaxCents: 500 });
    await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 10500, 'acct-gst': 500, 'acct-cash': -11000 });
    expectEveryEntryBalanced();
  });

  it('category change moves only the category line; 2100 and cash untouched', async () => {
    seedRegistrant();
    h.fake.state.expenses[0].categoryId = 'acct-travel';
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db, { categoryChanged: true })).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });
    expect(pnlExpenseCents()).toBe(10000);
    expectEveryEntryBalanced();
  });

  it('category cleared sends the category line back to suspense, keeping the 2100 line', async () => {
    seedRegistrant();
    h.fake.state.expenses[0].categoryId = null;
    await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db, { categoryChanged: true });
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });
  });

  it('a matching ledger is a no-op (no amend written)', async () => {
    seedRegistrant();
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('delete reverses every line: books return to zero', async () => {
    seedRegistrant();
    Object.assign(h.fake.state.expenses[0], { amountCents: 22000, recoverableTaxCents: 2000 });
    await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect((await reverseExpenseJournalEntry('t1', 'exp-1')).reversed).toBe(true);
    expect(h.fake.netByAccount()).toEqual({});
    expectEveryEntryBalanced();
  });

  it('uncategorised -> categorised reclass moves the suspense debit and keeps the 2100 line', async () => {
    seedRegistrant('acct-suspense');
    h.fake.state.expenses[0].categoryId = 'acct-meals';
    await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });
    expect(h.fake.state.entries).toHaveLength(1);
    expect(pnlExpenseCents()).toBe(10000);
  });

  it('refuses an impossible recoverable figure rather than post a negative category line', async () => {
    seedRegistrant();
    Object.assign(h.fake.state.expenses[0], { amountCents: 500 }); // recoverable 1000 > gross 500
    await expect(repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).rejects.toBeInstanceOf(ExpenseLedgerShapeError);
    expect(h.fake.state.entries).toHaveLength(1);
  });
});
