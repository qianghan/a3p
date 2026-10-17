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
 *
 * (expense.undo_last / expense.update_amount used to be pinned here too — they
 * now run through the shared repost/unbook helpers; see
 * agentbook-bot-agent-expense-ledger.test.ts.)
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
