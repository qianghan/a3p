// @vitest-environment node
/**
 * PR 3d.4 — the daily-pulse "zero-input bookkeeping" auto-record never turns
 * a bank debit that could be paying an open bill into an expense (that would
 * count the bill's expense twice). A debit with no bill candidate still is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logger', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ requireCronSecret: () => null }));
const cands = vi.fn(async (..._a: unknown[]): Promise<any[]> => []);
vi.mock('@/lib/agentbook-payment-matcher', () => ({ matchTransactionWithCandidates: (...a: unknown[]) => cands(...a), REVIEW_THRESHOLD: 0.55 }));
const expenseCreate = vi.fn(async (a: any) => a.data);
const txnFindMany = vi.fn(async (_a: any): Promise<any[]> => []);
const txnUpdate = vi.fn(async (_a: any) => ({}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findMany: async () => [{ userId: 't1', timezone: 'America/New_York' }] },
    abExpense: { aggregate: async () => ({ _sum: { amountCents: 0 }, _count: 0 }), count: async () => 0, create: (a: any) => expenseCreate(a) },
    abEvent: { create: async () => ({}) },
    abBankTransaction: { findMany: (a: any) => txnFindMany(a), update: (a: any) => txnUpdate(a) },
    abPattern: { findFirst: async () => ({ categoryId: 'acct-util', confidence: 0.95 }) },
  },
}));

import { GET } from '../route';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T13:00:00Z')); // 08:00 in New York
  vi.clearAllMocks();
  txnFindMany.mockResolvedValue([{ id: 'tx1', tenantId: 't1', amount: 8450, date: new Date('2026-11-22'), name: 'HYDRO ONE', merchantName: 'Hydro One' }]);
});
afterEach(() => vi.useRealTimers());

describe('daily-pulse auto-record', () => {
  it('skips a debit with a bill candidate: no expense, txn untouched', async () => {
    cands.mockResolvedValue([{ kind: 'bill', targetId: 'b1', score: 0.7 }]);
    await GET({ headers: new Headers() } as never);
    expect([expenseCreate.mock.calls.length, txnUpdate.mock.calls.length]).toEqual([0, 0]);
    expect(txnFindMany.mock.calls[0][0].where.matchedBillId).toBeNull();
  });
  it('still auto-records a debit with no bill candidate', async () => {
    cands.mockResolvedValue([{ kind: 'expense', targetId: 'e9', score: 0.4 }]);
    await GET({ headers: new Headers() } as never);
    expect(expenseCreate.mock.calls.map((c: any[]) => c[0].data.amountCents)).toEqual([8450]);
  });
  it('review M4: a low-score bill candidate (below the review threshold) does not hold the debit back', async () => {
    cands.mockResolvedValue([{ kind: 'bill', targetId: 'b-unrelated', score: 0.3 }]);
    await GET({ headers: new Headers() } as never);
    expect(expenseCreate.mock.calls.length).toBe(1);
  });
});
