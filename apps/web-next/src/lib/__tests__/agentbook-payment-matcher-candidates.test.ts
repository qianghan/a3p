/**
 * PR 49 / Tier 2 #5 — DB-coupled tests for matchTransactionWithCandidates.
 *
 * Verifies:
 *   - Returns up to N candidates ranked by score desc
 *   - Skips soft-deleted expenses (deletedAt != null)
 *   - Skips status != 'confirmed' (pending_review, rejected)
 *   - Skips expenses already linked to a different bank txn
 *   - Single-best matchTransaction() still works (delegates to the new fn)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// Prisma mocks. The matcher only touches abInvoice.findMany,
// abExpense.findMany, abBankTransaction.findMany — we stub those.
const mockInvoiceFindMany = vi.fn();
const mockExpenseFindMany = vi.fn();
const mockBankTxnFindMany = vi.fn();
const mockBillFindMany = vi.fn(async () => [] as unknown[]);
vi.mock('@naap/database', () => ({
  prisma: {
    abInvoice: { findMany: (...args: unknown[]) => mockInvoiceFindMany(...args) },
    abExpense: { findMany: (...args: unknown[]) => mockExpenseFindMany(...args) },
    abBankTransaction: { findMany: (...args: unknown[]) => mockBankTxnFindMany(...args) },
    abBill: { findMany: (...args: unknown[]) => (mockBillFindMany as any)(...args) },
  },
}));

import {
  matchTransaction,
  matchTransactionWithCandidates,
  type MatchableTxn,
} from '../agentbook-payment-matcher';

const today = new Date('2026-05-26T12:00:00Z');
const dayBefore = new Date('2026-05-25T12:00:00Z');

function outflow(overrides: Partial<MatchableTxn> = {}): MatchableTxn {
  return {
    id: 'tx-1',
    amountCents: 4500,
    date: today,
    name: 'BLUEBOTTLE COFFEE',
    merchantName: 'Blue Bottle',
    ...overrides,
  };
}

function inflow(overrides: Partial<MatchableTxn> = {}): MatchableTxn {
  return {
    id: 'tx-1',
    amountCents: -120000,
    date: today,
    name: 'STRIPE TRANSFER',
    merchantName: 'Stripe',
    ...overrides,
  };
}

function expRow(o: Partial<{
  id: string;
  amountCents: number;
  date: Date;
  description: string | null;
  vendor: { name: string } | null;
}> = {}) {
  return {
    id: o.id ?? 'exp-1',
    amountCents: o.amountCents ?? 4500,
    date: o.date ?? dayBefore,
    description: o.description ?? 'Coffee at Blue Bottle',
    vendor: o.vendor ?? { name: 'Blue Bottle' },
  };
}

function invRow(o: Partial<{
  id: string;
  amountCents: number;
  issuedDate: Date;
  dueDate: Date;
  status: string;
  client: { name: string } | null;
}> = {}) {
  return {
    id: o.id ?? 'inv-1',
    amountCents: o.amountCents ?? 120000,
    issuedDate: o.issuedDate ?? dayBefore,
    dueDate: o.dueDate ?? new Date('2026-06-25T12:00:00Z'),
    status: o.status ?? 'sent',
    client: o.client ?? { name: 'Stripe Inc' },
  };
}

describe('matchTransactionWithCandidates — expense path', () => {
  beforeEach(() => {
    mockInvoiceFindMany.mockReset();
    mockExpenseFindMany.mockReset();
    mockBankTxnFindMany.mockReset();
    mockBankTxnFindMany.mockResolvedValue([]); // by default, no already-matched
  });

  it('returns the best candidate when only one matches', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([expRow()]);
    const results = await matchTransactionWithCandidates('tenant', outflow());
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('expense');
    expect(results[0].targetId).toBe('exp-1');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('ranks multiple candidates by score desc', async () => {
    // Better candidate: vendor matches exactly. Worse: only date close.
    mockExpenseFindMany.mockResolvedValueOnce([
      expRow({ id: 'exp-better', vendor: { name: 'Blue Bottle' }, description: 'coffee' }),
      expRow({ id: 'exp-worse', vendor: { name: 'Random Cafe' }, description: 'tea', amountCents: 4520 }),
    ]);
    const results = await matchTransactionWithCandidates('tenant', outflow(), 3);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].targetId).toBe('exp-better');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('skips expenses already matched to another bank txn (no double-attribution)', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([
      expRow({ id: 'exp-already' }),
      expRow({ id: 'exp-free', amountCents: 4505 }),
    ]);
    mockBankTxnFindMany.mockResolvedValueOnce([
      { matchedExpenseId: 'exp-already' },
    ]);
    const results = await matchTransactionWithCandidates('tenant', outflow(), 3);
    expect(results.map((r) => r.targetId)).not.toContain('exp-already');
    expect(results.map((r) => r.targetId)).toContain('exp-free');
  });

  it('respects the limit parameter', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([
      expRow({ id: 'e1' }),
      expRow({ id: 'e2', amountCents: 4510 }),
      expRow({ id: 'e3', amountCents: 4520 }),
      expRow({ id: 'e4', amountCents: 4530 }),
    ]);
    const results = await matchTransactionWithCandidates('tenant', outflow(), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when no candidates score above zero', async () => {
    // Amount way outside tolerance — score should be 0 for everything.
    mockExpenseFindMany.mockResolvedValueOnce([
      expRow({ id: 'e1', amountCents: 99999 }),
    ]);
    const results = await matchTransactionWithCandidates('tenant', outflow());
    expect(results).toEqual([]);
  });

  it('the prisma where clause excludes deletedAt and non-confirmed', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([]);
    await matchTransactionWithCandidates('tenant', outflow());
    const [args] = mockExpenseFindMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.status).toBe('confirmed');
    expect(args.where.isPersonal).toBe(false);
  });
});

describe('matchTransactionWithCandidates — invoice path', () => {
  beforeEach(() => {
    mockInvoiceFindMany.mockReset();
    mockExpenseFindMany.mockReset();
    mockBankTxnFindMany.mockReset();
  });

  it('returns the best invoice candidate for an inflow', async () => {
    mockInvoiceFindMany.mockResolvedValueOnce([invRow()]);
    const results = await matchTransactionWithCandidates('tenant', inflow());
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('invoice');
    expect(results[0].targetId).toBe('inv-1');
  });

  it('returns empty when no invoice candidate scores above zero', async () => {
    mockInvoiceFindMany.mockResolvedValueOnce([
      invRow({ id: 'inv-bad', amountCents: 1, clientName: 'Unknown' } as never),
    ]);
    const results = await matchTransactionWithCandidates('tenant', inflow());
    expect(results).toEqual([]);
  });
});

describe('matchTransaction — single-best wrapper', () => {
  beforeEach(() => {
    mockInvoiceFindMany.mockReset();
    mockExpenseFindMany.mockReset();
    mockBankTxnFindMany.mockResolvedValue([]);
  });

  it('returns { kind: "none", score: 0 } when no candidates found', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([]);
    const result = await matchTransaction('tenant', outflow());
    expect(result.kind).toBe('none');
    expect(result.score).toBe(0);
  });

  it('returns the top candidate from matchTransactionWithCandidates', async () => {
    mockExpenseFindMany.mockResolvedValueOnce([
      expRow({ id: 'exp-1' }),
      expRow({ id: 'exp-2', amountCents: 4505 }),
    ]);
    const result = await matchTransaction('tenant', outflow());
    expect(result.kind).toBe('expense');
    expect(result.targetId).toBe('exp-1');
  });
});

describe('PR 3d.4 — bill candidates for a debit', () => {
  it('an open bill for the same amount/vendor outranks (or ties above) the expense; paid-down bills use what is owing', async () => {
    mockBankTxnFindMany.mockResolvedValue([]);
    mockExpenseFindMany.mockResolvedValue([expRow({ id: 'exp-1', date: today })]);
    mockBillFindMany.mockResolvedValue([
      { id: 'bill-1', vendorName: 'Blue Bottle', amountCents: 4500, paidCents: 0, status: 'open', billDate: dayBefore, dueDate: new Date('2026-06-10T00:00:00Z') },
      { id: 'bill-2', vendorName: 'Blue Bottle', amountCents: 9000, paidCents: 4500, status: 'partial', billDate: dayBefore, dueDate: new Date('2026-06-10T00:00:00Z') },
      { id: 'bill-3', vendorName: 'Blue Bottle', amountCents: 9000, paidCents: 0, status: 'open', billDate: dayBefore, dueDate: new Date('2026-06-10T00:00:00Z') },
    ]);
    const out = await matchTransactionWithCandidates('t1', outflow(), 5);
    expect(out.slice(0, 2).map((r) => r.kind)).toEqual(['bill', 'bill']);
    expect(out.map((r) => r.targetId).sort()).toEqual(['bill-1', 'bill-2', 'exp-1']);
    const where = (mockBillFindMany.mock.calls[0] as any[])[0].where;
    expect([where.tenantId, where.deletedAt, where.status]).toEqual(['t1', null, { in: ['open', 'partial'] }]);
  });
  it('an inflow never proposes a bill', async () => {
    mockInvoiceFindMany.mockResolvedValue([]);
    mockBillFindMany.mockClear();
    await matchTransactionWithCandidates('t1', inflow(), 3);
    expect(mockBillFindMany).not.toHaveBeenCalled();
  });
});
