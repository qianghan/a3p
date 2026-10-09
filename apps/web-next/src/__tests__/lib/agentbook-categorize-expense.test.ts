// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
const backfill = vi.fn(async () => 'je-new');
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: (...a: unknown[]) => backfill(...(a as [])),
}));

import { memDb } from '@/__tests__/helpers/mem-db';
import { fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { categorizeExpense } from '@/lib/agentbook-categorize-expense';
import { SUSPENSE_CATEGORY_ERROR } from '@/lib/agentbook-expense-category';

beforeEach(() => {
  memDb.reset(fullSeed());
  backfill.mockClear();
});

describe('categorizeExpense — the one categorize path (route + mobile review)', () => {
  it("refuses another tenant's expense with 404 and writes nothing", async () => {
    const out = await categorizeExpense('t2', 'e6', { categoryId: 'b-meals' });
    expect(out).toEqual({ ok: false, status: 404, error: 'Expense not found' });
    expect(memDb.table('abExpense').writes).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('400 without a categoryId', async () => {
    expect(await categorizeExpense('t1', 'e6', {})).toEqual({ ok: false, status: 400, error: 'categoryId is required' });
  });

  it('applies the category, books it and learns the vendor (agent_confirmed = human certainty)', async () => {
    const out = await categorizeExpense('t1', 'e5', { categoryId: 'acc-meals', source: 'agent_confirmed' });
    expect(out.ok).toBe(true);
    expect(await memDb.table('abExpense').findFirst({ where: { id: 'e5' } })).toMatchObject({ categoryId: 'acc-meals', confidence: 1 });
    expect(backfill).toHaveBeenCalledWith('t1', 'e5');
    expect(await memDb.table('abPattern').findFirst({ where: { tenantId: 't1', vendorPattern: 'cafe' } })).toMatchObject({
      categoryId: 'acc-meals', confidence: 0.95, source: 'agent_confirmed',
    });
    expect((await memDb.table('abVendor').findFirst({ where: { id: 'v-cafe' } }))?.defaultCategoryId).toBe('acc-meals');
  });

  describe('validates the category itself (callers no longer have to)', () => {
    const INVALID = { ok: false, status: 400, code: 'invalid_category', error: 'categoryId is not one of your expense categories' };
    const nothingWritten = () => {
      expect(memDb.table('abExpense').writes).toEqual([]);
      expect(memDb.table('abPattern').writes).toEqual([]);
      expect(memDb.table('abVendor').writes).toEqual([]);
      expect(backfill).not.toHaveBeenCalled();
    };

    it("another tenant's expense account is invalid_category: no write, no backfill", async () => {
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'b-meals' })).toEqual(INVALID);
      nothingWritten();
    });

    it('a non-expense account (revenue, asset) is invalid_category', async () => {
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'acc-rev' })).toEqual(INVALID);
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'acc-cash' })).toEqual(INVALID);
      nothingWritten();
    });

    it('an inactive expense account is invalid_category', async () => {
      memDb.table('abAccount').rows.push({ id: 'acc-old', tenantId: 't1', code: '5400', name: 'Old', accountType: 'expense', isActive: false });
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'acc-old' })).toEqual(INVALID);
      nothingWritten();
    });

    it('an id that is no account at all is invalid_category', async () => {
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'nope' })).toEqual(INVALID);
      nothingWritten();
    });

    it('the 6999 suspense account is refused with a 422 invalid_category: the expense must stay uncategorized', async () => {
      // acc-susp is the tenant's own, active EXPENSE account — it passes every
      // other check. Stamping it on expense.categoryId would hide the row from
      // the needs-category filter, the auto-categorize watchdog and reports,
      // all of which key off categoryId === null.
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'acc-susp' })).toEqual({
        ok: false, status: 422, code: 'invalid_category', error: SUSPENSE_CATEGORY_ERROR,
      });
      nothingWritten();
      expect((await memDb.table('abExpense').findFirst({ where: { id: 'e5' } }))?.categoryId).toBeNull();
    });

    it("another tenant's suspense account stays the generic 400 (reveals nothing across tenants)", async () => {
      memDb.table('abAccount').rows.push({ id: 'b-susp', tenantId: 't2', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true });
      expect(await categorizeExpense('t1', 'e5', { categoryId: 'b-susp' })).toEqual(INVALID);
      nothingWritten();
    });

    it('a valid active expense account of the tenant is unchanged', async () => {
      const out = await categorizeExpense('t1', 'e5', { categoryId: 'acc-fuel' });
      expect(out.ok).toBe(true);
      expect(memDb.table('abExpense').writes).toEqual([
        { op: 'update', args: { where: { id: 'e5' }, data: { categoryId: 'acc-fuel', confidence: 1 } } },
      ]);
      expect(backfill).toHaveBeenCalledWith('t1', 'e5');
    });
  });

  it('an auto_categorize caller keeps its own confidence and a capped pattern', async () => {
    await categorizeExpense('t1', 'e5', { categoryId: 'acc-meals', source: 'auto_categorize', confidence: 0.99 });
    expect((await memDb.table('abExpense').findFirst({ where: { id: 'e5' } }))?.confidence).toBe(0.99);
    expect((await memDb.table('abPattern').findFirst({ where: { vendorPattern: 'cafe' } }))?.confidence).toBe(0.92);
  });
});
