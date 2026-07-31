/**
 * Route-level LEDGER WIRING guards.
 *
 * Why these exist: the helpers (ensureChartOfAccounts, backfillExpenseJournalEntry,
 * reverseExpenseJournalEntry) all had passing unit tests while PR #395's wiring
 * was still broken — because those tests exercised the helper, never whether the
 * ROUTE actually calls it, and under what conditions. #395 gated chart seeding on
 * `resolvedCategoryId`, which is null for precisely the tenants that have no
 * chart, so the seed never fired. Unit tests couldn't see that.
 *
 * These tests assert the wiring itself: that each money path invokes the right
 * helper at the right time. They are deliberately about CALLS, not arithmetic —
 * the arithmetic is covered by the helpers' own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const ensureChartOfAccounts = vi.fn();
const backfillExpenseJournalEntry = vi.fn();
const reverseExpenseJournalEntry = vi.fn();
const patternDelete = vi.fn();

vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: (...a: unknown[]) => ensureChartOfAccounts(...a),
  CASH_CODE: '1000',
}));
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: (...a: unknown[]) => backfillExpenseJournalEntry(...a),
  reverseExpenseJournalEntry: (...a: unknown[]) => reverseExpenseJournalEntry(...a),
}));

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-1' })),
}));
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({
  inferSource: () => 'test',
  inferActor: async () => 'test-actor',
}));
vi.mock('@/lib/agentbook-soft-delete', () => ({
  withSoftDelete: (w: Record<string, unknown>) => w,
  parseIncludeDeleted: () => false,
}));
// Run the handler body directly rather than through idempotency bookkeeping.
vi.mock('@/lib/agentbook-idempotency', () => ({
  withHttpIdempotency: async (
    request: Request,
    opts: { handler: (raw: string) => Promise<{ status: number; body: unknown }> },
  ) => {
    const raw = await request.text().catch(() => '');
    const r = await opts.handler(raw);
    return new Response(JSON.stringify(r.body), { status: r.status });
  },
}));

const expenseFindFirst = vi.fn();
const expenseUpdate = vi.fn();
const expenseCreate = vi.fn();
const vendorFindFirst = vi.fn();
const patternFindFirst = vi.fn();
const accountFindFirst = vi.fn();
const transaction = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: {
      findFirst: (...a: unknown[]) => expenseFindFirst(...a),
      update: (...a: unknown[]) => expenseUpdate(...a),
      create: (...a: unknown[]) => expenseCreate(...a),
      findMany: vi.fn(async () => []),
    },
    abVendor: {
      findFirst: (...a: unknown[]) => vendorFindFirst(...a),
      create: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({ id: 'v1', defaultCategoryId: null, normalizedName: 'tea' })),
    },
    abPattern: {
      findFirst: (...a: unknown[]) => patternFindFirst(...a),
      findUnique: (...a: unknown[]) => patternFindFirst(...a),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      delete: (...a: unknown[]) => patternDelete(...a),
    },
    abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    abJournalEntry: { create: vi.fn(async () => ({ id: 'je-1' })) },
    abEvent: { create: vi.fn(async () => ({})) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  ensureChartOfAccounts.mockResolvedValue({ seeded: false, count: 0 });
  backfillExpenseJournalEntry.mockResolvedValue('je-1');
  reverseExpenseJournalEntry.mockResolvedValue({ reversed: true });
  vendorFindFirst.mockResolvedValue(null);
  patternFindFirst.mockResolvedValue(null);
  patternDelete.mockResolvedValue({});
  accountFindFirst.mockResolvedValue({ id: 'acct-cash' });
  expenseCreate.mockResolvedValue({ id: 'exp-new' });
  // Callback-style $transaction (expense create) and array-style both appear.
  transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)({
          abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
          abJournalEntry: { create: vi.fn(async () => ({ id: 'je-1' })) },
          abExpense: { create: (...a: unknown[]) => expenseCreate(...a), update: (...a: unknown[]) => expenseUpdate(...a) },
          abEvent: { create: vi.fn(async () => ({})) },
        })
      : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('POST /expenses — chart seeding wiring (the #395 regression)', () => {
  it('seeds the chart even when NO categoryId is supplied — the case that has no chart to categorize into', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/route');
    const res = await POST(
      new NextRequest('http://x/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // exactly what mobile capture sends: amount + vendor, NO categoryId
        body: JSON.stringify({ amountCents: 1500, vendor: 'Tea', description: 'no category' }),
      }),
    );
    expect(res.status).toBeLessThan(500);
    // The heart of #395: gating this on a resolved category meant a 0-account
    // tenant never got a chart, so nothing could ever be booked.
    expect(ensureChartOfAccounts).toHaveBeenCalledWith('tenant-1');
  });

  it('does NOT seed for a personal expense (not a business ledger entry)', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/route');
    await POST(
      new NextRequest('http://x/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: 1500, vendor: 'Tea', isPersonal: true }),
      }),
    );
    expect(ensureChartOfAccounts).not.toHaveBeenCalled();
  });
});

describe('POST /expenses/:id/categorize — back-fill wiring (#386)', () => {
  it('books the ledger after assigning a category', async () => {
    expenseFindFirst.mockResolvedValue({ id: 'exp-1', tenantId: 'tenant-1', vendorId: null });
    expenseUpdate.mockResolvedValue({ id: 'exp-1', categoryId: 'acct-exp' });
    const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/[id]/categorize/route');
    const res = await POST(
      new NextRequest('http://x/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ categoryId: 'acct-exp' }),
      }),
      { params: Promise.resolve({ id: 'exp-1' }) },
    );
    expect(res.status).toBe(200);
    // Without this the expense stays invisible to P&L and the tax estimate.
    expect(backfillExpenseJournalEntry).toHaveBeenCalledWith('tenant-1', 'exp-1');
  });
});

describe('DELETE /expenses/:id — reversal wiring (#397)', () => {
  it('reverses the journal entry so a deleted expense stops counting in the books', async () => {
    expenseFindFirst.mockResolvedValue({
      id: 'exp-1', tenantId: 'tenant-1', amountCents: 4200, vendorId: null,
      categoryId: 'acct-exp', date: new Date(), description: 'Coffee', isPersonal: false,
    });
    expenseUpdate.mockResolvedValue({ id: 'exp-1' });
    const { DELETE } = await import('@/app/api/v1/agentbook-expense/expenses/[id]/route');
    const res = await DELETE(new NextRequest('http://x/exp', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'exp-1' }),
    });
    expect(res.status).toBe(200);
    expect(reverseExpenseJournalEntry).toHaveBeenCalled();
    expect(reverseExpenseJournalEntry.mock.calls[0][0]).toBe('tenant-1');
    expect(reverseExpenseJournalEntry.mock.calls[0][1]).toBe('exp-1');
  });

  it('a remembered category pointing at a deleted account cannot break the write', async () => {
    // AbPattern.categoryId is a bare String with no relation, so it can outlive
    // the account it names. AbJournalLine.accountId DOES have a real foreign
    // key — so a stale pattern did not degrade categorisation, it made the whole
    // expense fail with a raw Prisma FK error and recorded nothing. Three
    // recordings broke this way in one eval run once #416 began learning
    // patterns. Recording an expense must survive a bad remembered preference.
    vendorFindFirst.mockResolvedValue({ id: 'v1', normalizedName: 'aws', defaultCategoryId: null });
    patternFindFirst.mockResolvedValue({ id: 'pat-1', categoryId: 'acct-DELETED', confidence: 0.9 });
    // The category lookup misses; the cash lookup still resolves.
    accountFindFirst.mockImplementation(async (args: any) =>
      args?.where?.id === 'acct-DELETED' ? null : { id: 'acct-cash' },
    );

    const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/route');
    const res = await POST(
      new NextRequest('http://x/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: 124000, description: 'paid AWS for hosting', vendor: 'AWS' }),
      }),
    );

    expect(res.status).toBe(201);
    // And the dangling pattern is removed rather than left to fail every future
    // expense for this vendor.
    expect(patternDelete).toHaveBeenCalledWith({ where: { id: 'pat-1' } });
  });

  it('still uses a remembered category when its account exists', async () => {
    vendorFindFirst.mockResolvedValue({ id: 'v1', normalizedName: 'aws', defaultCategoryId: null });
    patternFindFirst.mockResolvedValue({ id: 'pat-1', categoryId: 'acct-hosting', confidence: 0.9 });
    accountFindFirst.mockResolvedValue({ id: 'acct-hosting' });

    const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/route');
    const res = await POST(
      new NextRequest('http://x/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: 124000, description: 'paid AWS', vendor: 'AWS' }),
      }),
    );

    expect(res.status).toBe(201);
    expect(patternDelete).not.toHaveBeenCalled();
  });
});
