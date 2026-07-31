/**
 * The Telegram bot keeps its OWN inline copies of the expense→ledger logic
 * (agentbook-bot-agent.ts) rather than calling the shared helpers in
 * agentbook-expense-ledger.ts. Both copies were written when "uncategorized"
 * implied "not on the books".
 *
 * That stopped being true once POST /expenses started posting uncategorized
 * expenses to the 6999 suspense account. These guards pin the two paths that
 * would otherwise go wrong in ways money notices:
 *
 *   expense.confirm       — booked a journal entry whenever a category was set,
 *                           without checking journalEntryId, so a suspense-booked
 *                           expense got a SECOND entry and was counted twice.
 *   expense.update_amount — only fixed the books for a CATEGORIZED expense, so
 *                           correcting an uncategorized one left the original
 *                           amount sitting in the ledger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const journalEntryCreate = vi.fn();
const journalEntryFindUnique = vi.fn();
const expenseFindUnique = vi.fn();
const expenseUpdate = vi.fn();
const accountFindFirst = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: {
      findUnique: (...a: unknown[]) => expenseFindUnique(...a),
      update: (...a: unknown[]) => expenseUpdate(...a),
    },
    abJournalEntry: {
      create: (...a: unknown[]) => journalEntryCreate(...a),
      findUnique: (...a: unknown[]) => journalEntryFindUnique(...a),
    },
    abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    abUserMemory: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock('@/lib/agentbook-account-resolver', () => ({
  resolveVehicleAccounts: vi.fn(async () => null),
}));

import { executeStep, type BotContext, type ActiveExpense } from '../agentbook-bot-agent';

function activeExpense(over: Partial<ActiveExpense> = {}): ActiveExpense {
  return {
    id: 'exp-1',
    amountCents: 2500,
    currency: 'USD',
    date: new Date('2026-07-01'),
    description: 'Coffee',
    vendorName: 'Tea',
    vendorId: null,
    categoryId: null,
    categoryName: null,
    isPersonal: false,
    status: 'confirmed',
    ...over,
  };
}

function ctx(active: ActiveExpense): BotContext {
  return { tenantId: 'tenant-1', active, categories: [] } as BotContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  accountFindFirst.mockResolvedValue({ id: 'acct-cash' });
  journalEntryCreate.mockResolvedValue({ id: 'je-new' });
  expenseUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  expenseFindUnique.mockResolvedValue({ journalEntryId: null });
});

describe('expense.confirm — must not double-book a suspense-booked expense', () => {
  it('does NOT create a second journal entry when the expense is already on the books', async () => {
    // The shape the create route now produces: booked to suspense, then the
    // user picked a category, then they tap Confirm.
    expenseFindUnique.mockResolvedValue({ journalEntryId: 'je-suspense' });

    const res = await executeStep(
      { id: 's1', skill: 'expense.confirm', args: {}, dependsOn: [] },
      ctx(activeExpense({ categoryId: 'acct-meals' })),
    );

    expect(res.success).toBe(true);
    // A second entry would count the same $25 twice in P&L and the tax estimate.
    expect(journalEntryCreate).not.toHaveBeenCalled();
    expect(expenseUpdate).toHaveBeenCalled(); // still confirms
  });

  it('still books a categorized expense that genuinely has no entry yet', async () => {
    expenseFindUnique.mockResolvedValue({ journalEntryId: null });

    await executeStep(
      { id: 's1', skill: 'expense.confirm', args: {}, dependsOn: [] },
      ctx(activeExpense({ categoryId: 'acct-meals' })),
    );

    expect(journalEntryCreate).toHaveBeenCalled();
  });
});

describe('expense.undo_last — must reverse an UNCATEGORIZED booked expense', () => {
  it('posts a reversing entry so undone money stops counting, even with no category', async () => {
    expenseFindUnique.mockResolvedValue({ journalEntryId: 'je-suspense' });
    journalEntryFindUnique.mockResolvedValue({
      id: 'je-suspense',
      memo: 'Expense: Coffee',
      lines: [
        { accountId: 'acct-uncategorized', debitCents: 2500, creditCents: 0, description: 'Coffee' },
        { accountId: 'acct-cash', debitCents: 0, creditCents: 2500, description: 'Payment' },
      ],
    });

    const res = await executeStep(
      { id: 's1', skill: 'expense.undo_last', args: {}, dependsOn: [] },
      ctx(activeExpense({ categoryId: null })),
    );

    expect(res).toMatchObject({ success: true });
    // Without this the expense is marked rejected while its money stays in the
    // P&L and the tax estimate.
    expect(journalEntryCreate).toHaveBeenCalled();
    const lines = journalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.find((l: { accountId: string }) => l.accountId === 'acct-uncategorized'))
      .toMatchObject({ debitCents: 0, creditCents: 2500 });
  });
});

describe('expense.update_amount — must fix the books for an UNCATEGORIZED booked expense', () => {
  it('reverses and re-posts at the new amount, against the account the original used', async () => {
    // Uncategorized (categoryId null) but booked to suspense — the state the
    // create route now produces for "I spent $25 at Tea".
    expenseFindUnique.mockResolvedValue({ journalEntryId: 'je-suspense' });
    journalEntryFindUnique.mockResolvedValue({
      id: 'je-suspense',
      memo: 'Expense: Coffee',
      lines: [
        { accountId: 'acct-uncategorized', debitCents: 2500, creditCents: 0, description: 'Coffee' },
        { accountId: 'acct-cash', debitCents: 0, creditCents: 2500, description: 'Payment' },
      ],
    });

    const res = await executeStep(
      { id: 's1', skill: 'expense.update_amount', args: { amountCents: 5200 }, dependsOn: [] },
      ctx(activeExpense({ categoryId: null })),
    );

    expect(res.success).toBe(true);
    // Gating this on categoryId meant the books kept the stale $25 forever.
    expect(journalEntryCreate).toHaveBeenCalledTimes(2); // reversal + replacement

    const replacement = journalEntryCreate.mock.calls[1][0].data;
    const lines = replacement.lines.create;
    // Debits the SAME account as the original — there is no category to use.
    expect(lines.find((l: { accountId: string }) => l.accountId === 'acct-uncategorized'))
      .toMatchObject({ debitCents: 5200, creditCents: 0 });
    expect(lines.find((l: { accountId: string }) => l.accountId === 'acct-cash'))
      .toMatchObject({ debitCents: 0, creditCents: 5200 });
    expect(lines.reduce((s: number, l: { debitCents: number }) => s + l.debitCents, 0))
      .toBe(lines.reduce((s: number, l: { creditCents: number }) => s + l.creditCents, 0));

    expect(expenseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: 5200 }) }),
    );
  });

  it('still just updates the amount when the expense never reached the ledger', async () => {
    expenseFindUnique.mockResolvedValue({ journalEntryId: null });

    await executeStep(
      { id: 's1', skill: 'expense.update_amount', args: { amountCents: 5200 }, dependsOn: [] },
      ctx(activeExpense({ categoryId: null })),
    );

    expect(journalEntryCreate).not.toHaveBeenCalled();
    expect(expenseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: 5200 }) }),
    );
  });
});
