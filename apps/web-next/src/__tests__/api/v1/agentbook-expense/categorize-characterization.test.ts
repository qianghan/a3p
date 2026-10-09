// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const backfill = vi.fn(async (): Promise<unknown> => 'je-new');
// Re-categorizing a BOOKED expense (e6, on 6999 suspense) reposts its journal
// entry through the REAL repost helper (spied) against mem-db.
const h = vi.hoisted(() => ({ repost: vi.fn() }));
vi.mock('@/lib/agentbook-expense-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agentbook-expense-ledger')>();
  h.repost.mockImplementation(actual.repostExpenseJournalEntry);
  return {
    ...actual,
    backfillExpenseJournalEntry: (...a: unknown[]) => backfill(...(a as [])),
    repostExpenseJournalEntry: (...a: unknown[]) => h.repost(...a),
  };
});

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { publicErrorMessage } from '@/lib/api-error';
import { POST } from '@/app/api/v1/agentbook-expense/expenses/[id]/categorize/route';

interface Body {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

const call = async (id: string, body: unknown, tenant = 't1') => {
  const res = await POST(
    tenantReq(`/api/v1/agentbook-expense/expenses/${id}/categorize`, tenant, { method: 'POST', body }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await json<Body>(res) };
};

const writes = (model: string) => memDb.table(model).writes;

beforeEach(() => {
  memDb.reset(fullSeed());
  backfill.mockReset();
  backfill.mockImplementation(async () => 'je-new');
  h.repost.mockClear();
});

/**
 * Pinned against the route BEFORE the categorize writes moved into
 * lib/agentbook-categorize-expense.ts. Must stay green, unchanged, after it.
 */
describe('POST /expenses/:id/categorize — characterization', () => {
  it('passes the tenant resolver response through untouched', async () => {
    const r = await call('e5', { categoryId: 'acc-meals' }, 'none');
    expect(r).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(writes('abExpense')).toEqual([]);
  });

  it('400 without a categoryId (and for an unparseable body), writing nothing', async () => {
    expect(await call('e5', {})).toEqual({ status: 400, body: { success: false, error: 'categoryId is required' } });
    const raw = await POST(
      tenantReq('/api/v1/agentbook-expense/expenses/e5/categorize', 't1', { method: 'POST', body: undefined }),
      { params: Promise.resolve({ id: 'e5' }) },
    );
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ success: false, error: 'categoryId is required' });
    expect(writes('abExpense')).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it("404 for another tenant's expense, writing nothing", async () => {
    expect(await call('e5', { categoryId: 'b-meals' }, 't2')).toEqual({
      status: 404,
      body: { success: false, error: 'Expense not found' },
    });
    expect(writes('abExpense')).toEqual([]);
    expect(writes('abPattern')).toEqual([]);
    expect(writes('abVendor')).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('200 returns the updated row and makes exactly the category, ledger and learning writes', async () => {
    const r = await call('e5', { categoryId: 'acc-meals', source: 'user' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data).toMatchObject({ id: 'e5', tenantId: 't1', categoryId: 'acc-meals', confidence: 1, vendorId: 'v-cafe' });

    expect(writes('abExpense')).toEqual([
      { op: 'update', args: { where: { id: 'e5' }, data: { categoryId: 'acc-meals', confidence: 1 } } },
    ]);
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith('t1', 'e5');
    expect(writes('abPattern')).toEqual([
      {
        op: 'upsert',
        args: {
          where: { tenantId_vendorPattern: { tenantId: 't1', vendorPattern: 'cafe' } },
          update: { categoryId: 'acc-meals', confidence: 0.95, source: 'user', usageCount: { increment: 1 }, lastUsed: expect.any(Date) },
          create: { tenantId: 't1', vendorPattern: 'cafe', categoryId: 'acc-meals', confidence: 0.95, source: 'user' },
        },
      },
    ]);
    expect(writes('abVendor')).toEqual([
      { op: 'update', args: { where: { id: 'v-cafe' }, data: { defaultCategoryId: 'acc-meals' } } },
    ]);
  });

  it('an existing vendor pattern is re-pointed and its usage counted', async () => {
    memDb.table('abPattern').rows.push({
      id: 'p-cafe', tenantId: 't1', vendorPattern: 'cafe', categoryId: 'acc-fuel', confidence: 0.92, source: 'auto_categorize', usageCount: 3,
    });
    await call('e5', { categoryId: 'acc-meals', source: 'auto_categorize', confidence: 0.86 });
    expect(await memDb.table('abExpense').findFirst({ where: { id: 'e5' } })).toMatchObject({ confidence: 0.86 });
    expect(await memDb.table('abPattern').findFirst({ where: { id: 'p-cafe' } })).toMatchObject({
      categoryId: 'acc-meals', confidence: 0.86, source: 'auto_categorize', usageCount: 4,
    });
  });

  it('an expense without a vendor is categorized and booked, with no learning writes', async () => {
    const r = await call('e6', { categoryId: 'acc-meals' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: 'e6', categoryId: 'acc-meals', confidence: 1 });
    // e6 is already BOOKED (on 6999 suspense): its entry is reposted onto the
    // category in the categorize transaction, not backfilled.
    expect(h.repost).toHaveBeenCalledWith('t1', 'e6', expect.anything(), { categoryChanged: true });
    expect(backfill).not.toHaveBeenCalled();
    expect(writes('abPattern')).toEqual([]);
    expect(writes('abVendor')).toEqual([]);
  });

  it('a ledger failure is a 500 with the public message, after the category write', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('relation "AbJournalLine" does not exist at db.internal:5432');
      backfill.mockImplementationOnce(async () => {
        throw boom;
      });
      const r = await call('e5', { categoryId: 'acc-meals' });
      // publicErrorMessage stamps a fresh random reference per call, so compare the shape.
      const shape = (m: string) => m.replace(/Reference: \w+/, 'Reference: <ref>');
      expect(r.status).toBe(500);
      expect(r.body.success).toBe(false);
      expect(shape(r.body.error ?? '')).toBe(shape(publicErrorMessage(boom)));
      expect(r.body.error).not.toContain('db.internal');
      expect(writes('abExpense')).toHaveLength(1);
      expect(writes('abPattern')).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('POST /expenses/:id/categorize — the category is validated (final review M4)', () => {
  it.each([
    ['another tenant\'s account', 'b-meals'],
    ['a revenue account', 'acc-rev'],
    ['an unknown id', 'nope'],
  ])('400 invalid_category for %s, writing nothing', async (_label, categoryId) => {
    expect(await call('e5', { categoryId })).toEqual({
      status: 400,
      body: { success: false, code: 'invalid_category', error: 'categoryId is not one of your expense categories' },
    });
    expect(writes('abExpense')).toEqual([]);
    expect(writes('abPattern')).toEqual([]);
    expect(writes('abVendor')).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('400 invalid_category for an inactive expense account', async () => {
    memDb.table('abAccount').rows.push({ id: 'acc-old', tenantId: 't1', code: '5400', name: 'Old', accountType: 'expense', isActive: false });
    expect((await call('e5', { categoryId: 'acc-old' })).status).toBe(400);
    expect(writes('abExpense')).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });
});
