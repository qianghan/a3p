/**
 * One-step entry (PR 1): POST /expenses takes the category WITH the expense, books it on that
 * category in the same transaction, validates it, and learns from a human's choice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  ensureUncategorizedAccount: vi.fn(),
  remember: vi.fn(),
  accountFindFirst: vi.fn(),
  expenseCreate: vi.fn(),
  journalCreate: vi.fn(),
}));

vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: (...a: unknown[]) => h.ensureUncategorizedAccount(...a),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ rememberVendorCategory: (...a: unknown[]) => h.remember(...a) }));
vi.mock('@/lib/agentbook-expense-ledger', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-1' })) }));
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'test', inferActor: async () => 'test-actor' }));
vi.mock('@/lib/agentbook-soft-delete', () => ({ withSoftDelete: (w: Record<string, unknown>) => w, parseIncludeDeleted: () => false }));
vi.mock('@/lib/agentbook-idempotency', () => ({
  withHttpIdempotency: async (request: Request, opts: { handler: (raw: string) => Promise<{ status: number; body: unknown }> }) => {
    const r = await opts.handler(await request.text().catch(() => ''));
    return new Response(JSON.stringify(r.body), { status: r.status });
  },
}));
vi.mock('@/lib/agentbook-auto-categorize', () => ({ autoCategorizeForTenant: vi.fn(), getPendingSuggestions: vi.fn(async () => []) }));
vi.mock('@naap/database', () => {
  const tx = {
    abAccount: { findFirst: (...a: unknown[]) => h.accountFindFirst(...a) },
    abJournalEntry: { create: (...a: unknown[]) => h.journalCreate(...a) },
    abExpense: { create: (...a: unknown[]) => h.expenseCreate(...a) },
    abEvent: { create: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      abExpense: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      abVendor: { upsert: vi.fn(async () => ({ id: 'v1', defaultCategoryId: null, normalizedName: 'cafe' })) },
      abPattern: { findUnique: vi.fn(async () => null), update: vi.fn(), delete: vi.fn() },
      abAccount: { findFirst: (...a: unknown[]) => h.accountFindFirst(...a) },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/v1/agentbook-expense/expenses/route');
  const res = await POST(new NextRequest('http://x/api/v1/agentbook-expense/expenses', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ensureUncategorizedAccount.mockResolvedValue({ id: 'acct-suspense' });
  h.remember.mockResolvedValue(true);
  h.journalCreate.mockResolvedValue({ id: 'je-1' });
  h.expenseCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'exp-new', ...data }));
  // category lookup → a live expense account; cash lookup → cash
  h.accountFindFirst.mockImplementation(async ({ where }: { where: { id?: string; code?: string; accountType?: string } }) => {
    if (where.code === '1000') return { id: 'acct-cash' };
    if (where.id === 'acc-fuel' && where.accountType === 'expense') return { id: 'acc-fuel' };
    return null;
  });
});

const lines = () => h.journalCreate.mock.calls[0][0].data.lines.create as Array<{ accountId: string; debitCents: number; creditCents: number }>;

describe('POST /expenses with a category — one request, booked on the real category', () => {
  it('books DR chosen category / CR cash, never suspense, and stamps the category on the row', async () => {
    const r = await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'user' });
    expect(r.status).toBe(201);
    expect(lines().find((l) => l.debitCents === 4200)!.accountId).toBe('acc-fuel');
    expect(lines().find((l) => l.creditCents === 4200)!.accountId).toBe('acct-cash');
    expect(h.ensureUncategorizedAccount).not.toHaveBeenCalled();
    expect(h.expenseCreate.mock.calls[0][0].data.categoryId).toBe('acc-fuel');
  });

  it("validates the category against THIS tenant's live expense accounts", async () => {
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel' });
    const probe = h.accountFindFirst.mock.calls.map((c) => c[0].where).find((w) => w.id === 'acc-fuel');
    expect(probe).toMatchObject({ id: 'acc-fuel', tenantId: 'tenant-1', accountType: 'expense', isActive: true });
  });

  it('rejects a category that is not the tenant\'s expense account (other tenant, asset, inactive): 400, nothing written', async () => {
    const r = await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'someone-elses', categorySource: 'user' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: 'invalid_category' });
    expect(h.expenseCreate).not.toHaveBeenCalled();
    expect(h.journalCreate).not.toHaveBeenCalled();
    expect(h.remember).not.toHaveBeenCalled();
  });
});

describe('POST /expenses — learning only from a human', () => {
  it("remembers the vendor's category when the caller says the user chose it", async () => {
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'user' });
    expect(h.remember).toHaveBeenCalledWith('tenant-1', 'Cafe', 'acc-fuel', 'user');
    h.remember.mockClear();
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'user_corrected' });
    expect(h.remember).toHaveBeenCalledWith('tenant-1', 'Cafe', 'acc-fuel', 'user_corrected');
  });

  it('an agent/chat caller that names a category without categorySource teaches nothing', async () => {
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel' });
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'auto_categorize' });
    await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'bogus' });
    expect(h.remember).not.toHaveBeenCalled();
  });

  it('no vendor, or no category → nothing to remember', async () => {
    await post({ amountCents: 4200, categoryId: 'acc-fuel', categorySource: 'user' });
    await post({ amountCents: 4200, vendor: 'Cafe', categorySource: 'user' });
    expect(h.remember).not.toHaveBeenCalled();
  });

  it('a failure while learning never fails the expense that was already saved', async () => {
    h.remember.mockRejectedValue(new Error('db down'));
    const r = await post({ amountCents: 4200, vendor: 'Cafe', categoryId: 'acc-fuel', categorySource: 'user' });
    expect(r.status).toBe(201);
  });
});
