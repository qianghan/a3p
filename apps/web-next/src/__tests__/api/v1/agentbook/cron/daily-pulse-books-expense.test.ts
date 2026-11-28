// @vitest-environment node
/**
 * Launch finding F5: the daily-pulse cron auto-recorded matched bank debits as
 * expenses with no journal entry, so the ledger and P&L disagreed. Each
 * auto-expense must be booked in the same transaction as its creation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;
let expenses: Row[];
let bankUpdates: Row[];
const booked: string[] = [];
let periodClosed = false;

const { PeriodClosed } = vi.hoisted(() => ({ PeriodClosed: class PeriodClosed extends Error {} }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/logger', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ requireCronSecret: () => null }));
vi.mock('@/lib/agentbook-payment-matcher', () => ({ matchTransactionWithCandidates: async () => [], REVIEW_THRESHOLD: 0.7 }));
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  ensureExpenseBookingAccounts: async () => undefined,
  ExpenseLedgerPeriodClosedError: PeriodClosed,
  bookExpenseJournalEntry: async (_t: string, id: string, tx: Row) => {
    if (tx !== txClient) throw new Error('booked outside the creating transaction');
    if (periodClosed) throw new PeriodClosed();
    booked.push(id);
    return { booked: true, journalEntryId: `je-${id}` };
  },
}));

const txClient: Row = {
  abExpense: { create: async ({ data }: Row) => { const e = { id: `e${expenses.length + 1}`, ...data }; expenses.push(e); return e; } },
  abBankTransaction: { update: async (a: Row) => { bankUpdates.push(a); return a; } },
};
const db: Row = {
  abTenantConfig: { findMany: async () => [{ userId: 't1', timezone: 'UTC', currency: 'CAD', defaultCurrency: 'CAD' }] },
  abExpense: { aggregate: async () => ({ _sum: { amountCents: 0 }, _count: 0 }), count: async () => 0 },
  abEvent: { create: async () => ({}) },
  abBankTransaction: { findMany: async () => [{ id: 'b1', amount: 4200, date: '2026-11-20', name: 'Coffee Co', merchantName: 'Coffee Co' }] },
  abPattern: { findFirst: async () => ({ categoryId: 'acct-meals', confidence: 0.95 }) },
  $transaction: async (fn: (t: Row) => unknown) => {
    const snapshot = expenses.length;
    try { return await fn(txClient); } catch (e) { expenses.length = snapshot; bankUpdates.length = 0; throw e; }
  },
};
vi.mock('@naap/database', () => ({ get prisma() { return db; } }));

import { GET } from '@/app/api/v1/agentbook/cron/daily-pulse/route';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T08:15:00Z'));
  expenses = []; bankUpdates = []; booked.length = 0; periodClosed = false;
});

const run = () => GET(new Request('http://x/api/v1/agentbook/cron/daily-pulse') as never);

describe('daily-pulse auto-expenses', () => {
  it('books the expense to the ledger in the transaction that creates it, in the tenant currency', async () => {
    await run();
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ status: 'confirmed', source: 'bank_sync', currency: 'CAD', amountCents: 4200 });
    expect(booked).toEqual(['e1']);
    expect(bankUpdates[0].data).toMatchObject({ matchStatus: 'matched', matchedExpenseId: 'e1' });
  });

  it('a closed period rolls the whole thing back and leaves the bank debit pending', async () => {
    periodClosed = true;
    const res = await run();
    expect(res.status).toBe(200);
    expect(expenses).toHaveLength(0);
    expect(bankUpdates).toHaveLength(0);
  });
});
