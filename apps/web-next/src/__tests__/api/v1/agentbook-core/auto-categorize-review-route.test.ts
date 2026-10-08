// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const backfill = vi.fn(async () => 'je-new');
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: (...a: unknown[]) => backfill(...(a as [])),
}));

import { memDb } from '@/__tests__/helpers/mem-db';
import { NextRequest } from 'next/server';
import { tenantReq, json, TENANT_HEADER } from '@/__tests__/helpers/route-request';
import { fullSeed, pendingMemoryRow, E6_SUGGESTION, NOW } from '@/__tests__/helpers/mobile-fixtures';
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import type { ReviewResult } from '@/lib/mobile/types';
import { POST } from '@/app/api/v1/agentbook-core/auto-categorize/review/route';

const E5_SUGGESTION = { ...E6_SUGGESTION, expenseId: 'e5', vendorName: 'Cafe', amountCents: 3500, description: 'Coffee', confidence: 0.6 };

const review = async (body: unknown, tenant = 't1') => {
  const res = await POST(tenantReq('/api/v1/agentbook-core/auto-categorize/review', tenant, { method: 'POST', body }));
  return { status: res.status, body: await json<{ success: boolean; data: { results: ReviewResult[] } }>(res) };
};
const row = (id: string) => memDb.table('abExpense').findFirst({ where: { id } });
const pendingIds = async () => (await getPendingSuggestions('t1')).map((p) => p.expenseId);

beforeEach(() => {
  const seed = fullSeed();
  seed.abUserMemory = [pendingMemoryRow('t1', [E6_SUGGESTION, E5_SUGGESTION])];
  memDb.reset(seed);
  backfill.mockClear();
});

describe('POST /auto-categorize/review — accept', () => {
  it('applies the suggestion through the categorize path: category, journal, suggestion dropped', async () => {
    const { status, body } = await review({ items: [{ expenseId: 'e6', action: 'accept' }] });
    expect(status).toBe(200);
    expect(body.data.results).toEqual([{ expenseId: 'e6', ok: true }]);
    expect(await row('e6')).toMatchObject({ categoryId: 'acc-meals', confidence: 1 });
    expect(backfill).toHaveBeenCalledWith('t1', 'e6');
    expect(await pendingIds()).toEqual(['e5']);
  });

  it('accepting the suggestion teaches the vendor as agent_confirmed', async () => {
    await review({ items: [{ expenseId: 'e5', action: 'accept' }] });
    expect(await memDb.table('abPattern').findFirst({ where: { tenantId: 't1', vendorPattern: 'cafe' } })).toMatchObject({
      categoryId: 'acc-meals', confidence: 0.95, source: 'agent_confirmed',
    });
  });

  it('accepting with a different category is a user correction', async () => {
    await review({ items: [{ expenseId: 'e5', action: 'accept', categoryId: 'acc-fuel' }] });
    expect((await row('e5'))?.categoryId).toBe('acc-fuel');
    expect(await memDb.table('abPattern').findFirst({ where: { vendorPattern: 'cafe' } })).toMatchObject({ categoryId: 'acc-fuel', source: 'user_corrected' });
    expect((await memDb.table('abVendor').findFirst({ where: { id: 'v-cafe' } }))?.defaultCategoryId).toBe('acc-fuel');
    expect(await pendingIds()).toEqual(['e6']);
  });
});

describe('POST /auto-categorize/review — reject', () => {
  it('drops the suggestion and leaves the expense uncategorized, with no ledger write', async () => {
    const { body } = await review({ items: [{ expenseId: 'e6', action: 'reject' }] });
    expect(body.data.results).toEqual([{ expenseId: 'e6', ok: true }]);
    expect((await row('e6'))?.categoryId).toBeNull();
    expect(backfill).not.toHaveBeenCalled();
    expect(await pendingIds()).toEqual(['e5']);
  });
});

describe('POST /auto-categorize/review — mixed batch and tenant isolation', () => {
  it('reports per item, in order, and never touches foreign rows or accounts', async () => {
    const { status, body } = await review({
      items: [
        { expenseId: 'e6', action: 'accept' },
        { expenseId: 'x1', action: 'accept', categoryId: 'acc-meals' },
        { expenseId: 'e5', action: 'accept', categoryId: 'b-meals' },
        { expenseId: 'e1', action: 'accept' },
      ],
    });
    expect(status).toBe(200);
    expect(body.data.results).toEqual([
      { expenseId: 'e6', ok: true },
      { expenseId: 'x1', ok: false, error: 'not_found' },
      { expenseId: 'e5', ok: false, error: 'invalid_category' },
      { expenseId: 'e1', ok: false, error: 'no_suggestion' },
    ]);
    expect((await row('x1'))?.categoryId).toBe('b-meals');
    expect((await row('e5'))?.categoryId).toBeNull();
    // Write nothing for the refused items: one ledger backfill (the valid item),
    // the invalid item's suggestion survives, no vendor pattern learned anywhere
    // (e6 has no vendor; e5/x1/e1 were refused).
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith('t1', 'e6');
    expect(await pendingIds()).toEqual(['e5']);
    expect(memDb.table('abPattern').rows).toEqual([]);
    expect((await memDb.table('abVendor').findFirst({ where: { id: 'v-cafe' } }))?.defaultCategoryId).toBeNull();
  });

  it('duplicate expenseIds are not deduped: results stay 1:1 in order (accept, accept → ok, no_suggestion)', async () => {
    const { body } = await review({
      items: [{ expenseId: 'e6', action: 'accept' }, { expenseId: 'e6', action: 'accept' }],
    });
    expect(body.data.results).toEqual([
      { expenseId: 'e6', ok: true },
      { expenseId: 'e6', ok: false, error: 'no_suggestion' },
    ]);
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  it("another tenant cannot accept t1's suggestions", async () => {
    const { body } = await review({ items: [{ expenseId: 'e6', action: 'accept', categoryId: 'b-meals' }] }, 't2');
    expect(body.data.results).toEqual([{ expenseId: 'e6', ok: false, error: 'not_found' }]);
    expect((await row('e6'))?.categoryId).toBeNull();
  });

  it('a deleted expense is not_found', async () => {
    memDb.table('abExpense').rows.find((r) => r.id === 'e6')!.deletedAt = NOW;
    expect((await review({ items: [{ expenseId: 'e6', action: 'accept' }] })).body.data.results[0]).toEqual({ expenseId: 'e6', ok: false, error: 'not_found' });
  });
});

describe('POST /auto-categorize/review — stale suggestions', () => {
  it('a bare accept on an expense the user already categorized is no_suggestion: nothing overwritten, stale suggestion dropped', async () => {
    memDb.table('abExpense').rows.find((r) => r.id === 'e5')!.categoryId = 'acc-fuel';
    const { body } = await review({ items: [{ expenseId: 'e5', action: 'accept' }] });
    expect(body.data.results).toEqual([{ expenseId: 'e5', ok: false, error: 'no_suggestion' }]);
    expect((await row('e5'))?.categoryId).toBe('acc-fuel');
    expect(backfill).not.toHaveBeenCalled();
    expect(memDb.table('abPattern').rows).toEqual([]);
    expect((await memDb.table('abVendor').findFirst({ where: { id: 'v-cafe' } }))?.defaultCategoryId).toBeNull();
    expect(await pendingIds()).toEqual(['e6']);
  });

  it('an explicit categoryId on an already-categorized expense is a deliberate re-pick and applies', async () => {
    memDb.table('abExpense').rows.find((r) => r.id === 'e6')!.categoryId = 'acc-fuel';
    const { body } = await review({ items: [{ expenseId: 'e6', action: 'accept', categoryId: 'acc-meals' }] });
    expect(body.data.results).toEqual([{ expenseId: 'e6', ok: true }]);
    expect((await row('e6'))?.categoryId).toBe('acc-meals');
    expect(backfill).toHaveBeenCalledWith('t1', 'e6');
    expect(await pendingIds()).toEqual(['e5']);
  });
});

describe('POST /auto-categorize/review — invalid_category', () => {
  it('refuses a non-expense account (revenue, asset)', async () => {
    const { body } = await review({
      items: [
        { expenseId: 'e5', action: 'accept', categoryId: 'acc-rev' },
        { expenseId: 'e6', action: 'accept', categoryId: 'acc-cash' },
      ],
    });
    expect(body.data.results).toEqual([
      { expenseId: 'e5', ok: false, error: 'invalid_category' },
      { expenseId: 'e6', ok: false, error: 'invalid_category' },
    ]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('refuses an inactive expense account', async () => {
    memDb.table('abAccount').rows.push({ id: 'acc-old', tenantId: 't1', code: '5400', name: 'Old', accountType: 'expense', isActive: false });
    const { body } = await review({ items: [{ expenseId: 'e5', action: 'accept', categoryId: 'acc-old' }] });
    expect(body.data.results).toEqual([{ expenseId: 'e5', ok: false, error: 'invalid_category' }]);
    expect((await row('e5'))?.categoryId).toBeNull();
  });

  it('refuses a stored suggestion whose account has since been deactivated; the suggestion is kept', async () => {
    memDb.table('abAccount').rows.find((r) => r.id === 'acc-meals')!.isActive = false;
    const { body } = await review({ items: [{ expenseId: 'e6', action: 'accept' }] });
    expect(body.data.results).toEqual([{ expenseId: 'e6', ok: false, error: 'invalid_category' }]);
    expect((await row('e6'))?.categoryId).toBeNull();
    expect(backfill).not.toHaveBeenCalled();
    expect(await pendingIds()).toEqual(['e6', 'e5']);
  });
});

describe('POST /auto-categorize/review — failure isolation and repeats', () => {
  it('one failing item reports a code and does not abort the rest; its suggestion stays for a retry', async () => {
    backfill.mockRejectedValueOnce(new Error('ledger down'));
    const { status, body } = await review({
      items: [{ expenseId: 'e6', action: 'accept' }, { expenseId: 'e5', action: 'accept' }],
    });
    expect(status).toBe(200);
    expect(body.data.results).toEqual([
      { expenseId: 'e6', ok: false, error: 'failed' },
      { expenseId: 'e5', ok: true },
    ]);
    expect(await pendingIds()).toEqual(['e6']);
  });

  it('a repeated accept without a categoryId is no_suggestion; a repeated reject is ok and writes nothing', async () => {
    await review({ items: [{ expenseId: 'e6', action: 'accept' }] });
    expect((await review({ items: [{ expenseId: 'e6', action: 'accept' }] })).body.data.results).toEqual([
      { expenseId: 'e6', ok: false, error: 'no_suggestion' },
    ]);
    expect((await row('e6'))?.categoryId).toBe('acc-meals');

    await review({ items: [{ expenseId: 'e5', action: 'reject' }] });
    expect((await review({ items: [{ expenseId: 'e5', action: 'reject' }] })).body.data.results).toEqual([
      { expenseId: 'e5', ok: true },
    ]);
    expect((await row('e5'))?.categoryId).toBeNull();
    expect(await pendingIds()).toEqual([]);
  });
});

describe('POST /auto-categorize/review — validation', () => {
  it('400 for an empty list, more than 50 items, a bad action or a non-JSON body; 401 without a session', async () => {
    expect((await review({ items: [] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ expenseId: `e${i}`, action: 'reject' }));
    expect((await review({ items: many })).status).toBe(400);
    expect((await review({ items: [{ expenseId: 'e6', action: 'maybe' }] })).status).toBe(400);
    expect((await review('not json')).status).toBe(400);
    expect((await review({ items: [{ expenseId: 'e6', action: 'reject' }] }, 'none')).status).toBe(401);
  });

  it('400 for a body that is not parseable JSON at all', async () => {
    const req = new NextRequest(new URL('/api/v1/agentbook-core/auto-categorize/review', 'http://test.local'), {
      method: 'POST', headers: { [TENANT_HEADER]: 't1', 'content-type': 'application/json' }, body: '{items:',
    });
    expect((await POST(req)).status).toBe(400);
  });

  it('accepts exactly 50 items', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ expenseId: `nope-${i}`, action: 'reject' }));
    const { status, body } = await review({ items: fifty });
    expect(status).toBe(200);
    expect(body.data.results).toHaveLength(50);
  });
});
