import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ fake: null as any }));
vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({ ensureChartOfAccounts: vi.fn(), ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })), CASH_CODE: '1000', UNCATEGORIZED_CODE: '6999' }));

import {
  repostExpenseJournalEntry,
  unbookExpenseJournalEntry,
  bookExpenseJournalEntry,
  ExpenseLedgerPeriodClosedError,
  ExpenseLedgerShapeError,
} from '../agentbook-expense-ledger';

const JAN = new Date('2026-01-15T12:00:00.000Z');
beforeEach(() => { h.fake = createFakeLedgerDb(); });

describe('repostExpenseJournalEntry', () => {
  it('is a no-op when the ledger already matches the expense (idempotent, self-healing check)', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r.reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('reports "not booked" without writing when the expense has no journal entry', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].journalEntryId = null;
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r).toMatchObject({ reposted: false, journalEntryId: null });
  });

  it('repairs a ledger that drifted from the expense, and a second call is then a no-op', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].amountCents = 5200; // drift (e.g. the pre-fix edit path)
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(3);
  });

  it('does not look at another tenant\'s expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, tenantId: 't2' });
    h.fake.state.expenses[0].amountCents = 5200;
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r.reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('exports typed errors the route maps to 422', () => {
    expect(new ExpenseLedgerPeriodClosedError(2026, 1)).toBeInstanceOf(Error);
    expect(new ExpenseLedgerShapeError().message).toMatch(/split|multi/i);
  });

  it('never re-posts onto an account the tenant does not own, even when the expense row names one', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].categoryId = 'acct-t2-meals'; // legacy row written before PUT validated categoryId
    h.fake.state.expenses[0].amountCents = 5200;
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
  });

  it.each([['inactive', 'acct-old'], ['non-expense', 'acct-revenue']])(
    'never re-posts onto an %s account',
    async (_n, acct) => {
      h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
      h.fake.state.expenses[0].categoryId = acct;
      const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
      expect(r.reposted).toBe(false);
      expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
    },
  );

  it('heals a category the ledger never followed (e.g. set by the categorize path) onto a valid account', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].categoryId = 'acct-travel';
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
  });

  it('refuses to mirror an unbalanced (corrupt) original', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.creditCents > 0).creditCents = 4100;
    h.fake.state.expenses[0].amountCents = 5200;
    await expect(repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).rejects.toBeInstanceOf(ExpenseLedgerShapeError);
  });

  it('does not touch a deleted or rejected expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].amountCents = 5200;
    h.fake.state.expenses[0].deletedAt = new Date();
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reason).toBe('deleted');
    h.fake.state.expenses[0].deletedAt = null;
    h.fake.state.expenses[0].status = 'rejected';
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reason).toBe('rejected');
    expect((await unbookExpenseJournalEntry('t1', 'exp-1', h.fake.db)).unbooked).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('book: posts a confirmed business expense once, and is a no-op when already booked or still pending', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.entries.length = 0;
    h.fake.state.lines.length = 0;
    const row = h.fake.state.expenses[0];
    row.journalEntryId = null;

    row.status = 'pending_review';
    expect((await bookExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reason).toBe('pending review');
    row.status = 'confirmed';
    expect((await bookExpenseJournalEntry('t1', 'exp-1', h.fake.db)).booked).toBe(true);
    expect((await bookExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reason).toBe('already booked');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('book: refuses (throws) rather than silently skip when there is no account to post to', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, categoryId: null });
    h.fake.state.entries.length = 0;
    h.fake.state.lines.length = 0;
    h.fake.state.expenses[0].journalEntryId = null;
    h.fake.state.accounts = h.fake.state.accounts.filter((a: any) => a.code !== '6999');
    await expect(bookExpenseJournalEntry('t1', 'exp-1', h.fake.db)).rejects.toThrow(/chart of accounts/);
  });
});

