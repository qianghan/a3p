import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const expenseFindFirst = vi.fn();
const journalLineFindMany = vi.fn();
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
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
  },
}));

const ensureChartOfAccounts = vi.fn();
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: (...a: unknown[]) => ensureChartOfAccounts(...a),
  CASH_CODE: '1000',
}));

import { backfillExpenseJournalEntry, reverseExpenseJournalEntry } from '../agentbook-expense-ledger';

const EXPENSE = {
  id: 'exp-1', tenantId: 't1', categoryId: 'acct-expense', isPersonal: false,
  journalEntryId: null, amountCents: 4200, description: 'Coffee', date: new Date('2026-02-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
  accountFindFirst.mockResolvedValue({ id: 'acct-cash-1000' });
  journalCreate.mockResolvedValue({ id: 'je-new' });
  expenseUpdate.mockResolvedValue({});
  ensureChartOfAccounts.mockResolvedValue({ seeded: false, count: 0 });
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

  it('SEEDS the chart on demand when Cash is missing, then posts (no longer gives up)', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE });
    // absent on the first lookup, present after seeding
    accountFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'acct-cash-1000' });

    const id = await backfillExpenseJournalEntry('t1', 'exp-1');

    expect(ensureChartOfAccounts).toHaveBeenCalledWith('t1');
    expect(id).toBe('je-new');
    expect(journalCreate).toHaveBeenCalled(); // the expense reaches the books
  });

  it('does not seed when Cash already exists (no needless work on the hot path)', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE });
    accountFindFirst.mockResolvedValue({ id: 'acct-cash-1000' });
    await backfillExpenseJournalEntry('t1', 'exp-1');
    expect(ensureChartOfAccounts).not.toHaveBeenCalled();
  });

  it('returns null without posting if seeding genuinely fails (never a half entry)', async () => {
    expenseFindFirst.mockResolvedValue({ ...EXPENSE });
    accountFindFirst.mockResolvedValue(null); // still missing even after seeding
    expect(await backfillExpenseJournalEntry('t1', 'exp-1')).toBeNull();
    expect(ensureChartOfAccounts).toHaveBeenCalled();
    expect(journalCreate).not.toHaveBeenCalled();
  });
});

describe('reverseExpenseJournalEntry — deleting an expense must not leave it in the books', () => {
  const ORIGINAL_LINES = [
    { accountId: 'acct-expense', debitCents: 4200, creditCents: 0, description: 'Coffee' },
    { accountId: 'acct-cash-1000', debitCents: 0, creditCents: 4200, description: 'Payment' },
  ];

  it('mirrors the original lines with debit/credit swapped, and stays balanced', async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: 'je-orig', description: 'Coffee' });
    journalLineFindMany.mockResolvedValue(ORIGINAL_LINES);
    journalCreate.mockResolvedValue({ id: 'je-reversal' });

    const r = await reverseExpenseJournalEntry('t1', 'exp-1');
    expect(r.reversed).toBe(true);

    const data = journalCreate.mock.calls[0][0].data;
    const lines = data.lines.create;
    // same accounts, sides flipped
    expect(lines.find((l: any) => l.accountId === 'acct-expense')).toMatchObject({ debitCents: 0, creditCents: 4200 });
    expect(lines.find((l: any) => l.accountId === 'acct-cash-1000')).toMatchObject({ debitCents: 4200, creditCents: 0 });
    // still balanced
    expect(lines.reduce((s: number, l: any) => s + l.debitCents, 0))
      .toBe(lines.reduce((s: number, l: any) => s + l.creditCents, 0));
  });

  it("writes under sourceType 'expense_delete' so it can't collide with the original entry", async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: 'je-orig', description: 'Coffee' });
    journalLineFindMany.mockResolvedValue(ORIGINAL_LINES);
    journalCreate.mockResolvedValue({ id: 'je-reversal' });

    await reverseExpenseJournalEntry('t1', 'exp-1');
    const data = journalCreate.mock.calls[0][0].data;
    expect(data.sourceType).toBe('expense_delete'); // NOT 'expense' — unique(tenantId,sourceType,sourceId)
    expect(data.sourceId).toBe('exp-1');
    expect(data.memo).toMatch(/reverse/i);
  });

  it('mirrors a 3-line entry (e.g. tax liability) without needing to know its shape', async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: 'je-orig', description: 'AU purchase' });
    journalLineFindMany.mockResolvedValue([
      { accountId: 'exp', debitCents: 1000, creditCents: 0, description: 'net' },
      { accountId: 'gst', debitCents: 100, creditCents: 0, description: 'GST' },
      { accountId: 'cash', debitCents: 0, creditCents: 1100, description: 'paid' },
    ]);
    journalCreate.mockResolvedValue({ id: 'je-reversal' });

    await reverseExpenseJournalEntry('t1', 'exp-au');
    const lines = journalCreate.mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(3);
    expect(lines.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(1100);
    expect(lines.reduce((s: number, l: any) => s + l.creditCents, 0)).toBe(1100);
  });

  it('is a no-op when the expense never reached the ledger', async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: null, description: 'never booked' });
    const r = await reverseExpenseJournalEntry('t1', 'exp-1');
    expect(r.reversed).toBe(false);
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it('is idempotent — a double delete does not double-reverse (P2002 treated as done)', async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: 'je-orig', description: 'Coffee' });
    journalLineFindMany.mockResolvedValue(ORIGINAL_LINES);
    journalCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const r = await reverseExpenseJournalEntry('t1', 'exp-1');
    expect(r.reversed).toBe(false);
    expect(r.reason).toMatch(/already reversed/);
  });

  it('rethrows a genuine database error rather than silently leaving the books wrong', async () => {
    expenseFindFirst.mockResolvedValue({ journalEntryId: 'je-orig', description: 'Coffee' });
    journalLineFindMany.mockResolvedValue(ORIGINAL_LINES);
    journalCreate.mockRejectedValue(new Error('db exploded'));
    await expect(reverseExpenseJournalEntry('t1', 'exp-1')).rejects.toThrow('db exploded');
  });
});
