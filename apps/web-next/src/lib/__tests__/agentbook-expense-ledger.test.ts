import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const expenseFindFirst = vi.fn();
const accountFindFirst = vi.fn();
const journalCreate = vi.fn();
const expenseUpdate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: {
      findFirst: (...a: unknown[]) => expenseFindFirst(...a),
      update: (...a: unknown[]) => expenseUpdate(...a),
    },
    abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    abJournalEntry: { create: (...a: unknown[]) => journalCreate(...a) },
  },
}));

import { backfillExpenseJournalEntry } from '../agentbook-expense-ledger';

const EXPENSE = {
  id: 'exp-1', tenantId: 't1', categoryId: 'acct-expense', isPersonal: false,
  journalEntryId: null, amountCents: 4200, description: 'Coffee', date: new Date('2026-02-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
  accountFindFirst.mockResolvedValue({ id: 'acct-cash-1000' });
  journalCreate.mockResolvedValue({ id: 'je-new' });
  expenseUpdate.mockResolvedValue({});
});

describe('backfillExpenseJournalEntry', () => {
  it('books a BALANCED entry (DR category / CR cash) for a categorized, unbooked expense and stamps journalEntryId', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE });
    const id = await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(id).toBe('je-new');
    const lines = journalCreate.mock.calls[0][0].data.lines.create;
    const debit = lines.reduce((s: number, l: any) => s + l.debitCents, 0);
    const credit = lines.reduce((s: number, l: any) => s + l.creditCents, 0);
    expect(debit).toBe(credit);                 // balanced
    expect(debit).toBe(4200);                   // equals the expense amount
    expect(lines.find((l: any) => l.accountId === 'acct-expense').debitCents).toBe(4200);
    expect(lines.find((l: any) => l.accountId === 'acct-cash-1000').creditCents).toBe(4200);
    expect(expenseUpdate).toHaveBeenCalledWith({ where: { id: 'exp-1' }, data: { journalEntryId: 'je-new' } });
  });

  it('is idempotent — no-op when the expense is already booked', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE, journalEntryId: 'je-existing' });
    const id = await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(id).toBe('je-existing');
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it('no-op when the expense has no category yet', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE, categoryId: null });
    expect(await backfillExpenseJournalEntry('t1', 'exp-1')).toBeNull();
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it('no-op for a personal expense (not a business ledger entry)', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE, isPersonal: true });
    expect(await backfillExpenseJournalEntry('t1', 'exp-1')).toBeNull();
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it('no-op (best-effort) when the Cash account 1000 is not seeded', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE });
    accountFindFirst.mockResolvedValue(null);
    expect(await backfillExpenseJournalEntry('t1', 'exp-1')).toBeNull();
    expect(journalCreate).not.toHaveBeenCalled();
  });
});
