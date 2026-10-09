/**
 * POST /expenses/:id/categorize — "Change category" on a BOOKED expense must
 * move its journal entry, exactly like a categoryId PATCH does.
 *
 * The categorize path only called backfillExpenseJournalEntry, which moves a
 * debit sitting on 6999 suspense and returns early when the debit already sits
 * on a real category. Meals → Travel therefore left the row saying Travel and
 * the books saying {meals: 4200, cash: -4200}: P&L by category and the trial
 * balance by account were wrong, and nobody was told.
 *
 * Same harness as expense-edit-reposts-ledger.test.ts: the REAL route, the REAL
 * categorize lib and the REAL ledger helpers against fake-ledger-db, which
 * applies `where`, enforces the G-021 unique key and ROLLS BACK a failed
 * $transaction — so "nothing was written" assertions are meaningful.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  fake: null as any,
  tenant: 't1',
  pending: [] as Array<{ expenseId: string; suggestedCategoryId: string }>,
  events: [] as unknown[],
}));

vi.mock('@naap/database', () => ({
  prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }),
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: h.tenant })),
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
// The bulk review reads its pending list from abUserMemory; only that seam is faked.
vi.mock('@/lib/agentbook-auto-categorize', () => ({
  getPendingSuggestions: vi.fn(async () => h.pending.map((p) => ({ ...p }))),
  dropPendingSuggestion: vi.fn(async (_t: string, id: string) => {
    h.pending = h.pending.filter((p) => p.expenseId !== id);
    return 1;
  }),
}));

const D = (s: string) => new Date(s);
const JAN = D('2026-01-15T12:00:00.000Z');

async function categorize(categoryId: string, id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/categorize/route');
  const res = await route.POST(
    new NextRequest(`http://x/api/v1/agentbook-expense/expenses/${id}/categorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categoryId, source: 'user' }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: await res.json() };
}

async function review(items: unknown[]) {
  const route = await import('@/app/api/v1/agentbook-core/auto-categorize/review/route');
  const res = await route.POST(
    new NextRequest('http://x/api/v1/agentbook-core/auto-categorize/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
  );
  return { status: res.status, json: await res.json() };
}

const row = (id = 'exp-1') => h.fake.state.expenses.find((e: any) => e.id === id);
const snap = () =>
  JSON.parse(JSON.stringify({ e: h.fake.state.expenses, j: h.fake.state.entries, l: h.fake.state.lines }));

beforeEach(() => {
  vi.clearAllMocks();
  h.fake = createFakeLedgerDb();
  h.tenant = 't1';
  h.pending = [];
});

describe('re-categorizing a BOOKED expense moves its journal entry', () => {
  it('Meals → Travel: the books follow the row ({travel: 4200, cash: -4200})', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    const { status, json } = await categorize('acct-travel');

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(row().categoryId).toBe('acct-travel');
    // The ledger — not just the expense row — now says Travel.
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
    // Posted entries are immutable: the original is untouched, a reversal +
    // replacement were appended, and the expense points at the replacement.
    const original = h.fake.state.lines.filter((l: any) => l.entryId === entryId);
    expect(original.map((l: any) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      ['acct-meals', 4200, 0],
      ['acct-cash', 0, 4200],
    ]);
    expect(h.fake.state.entries.map((e: any) => e.sourceType)).toEqual(['expense', 'expense_amend_reversal', 'expense_amend']);
    expect(row().journalEntryId).not.toBe(entryId);
    expect(json.data.journalEntryId).toBe(row().journalEntryId);
  });

  it('a retry after a lost response is a no-op: no new entry, books unchanged', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    expect((await categorize('acct-travel')).status).toBe(200);
    const after = snap();

    const retry = await categorize('acct-travel');
    expect(retry.status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(3);
    expect(snap().j).toEqual(after.j);
    expect(snap().l).toEqual(after.l);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
  });

  it('Meals → Travel → Meals: each change is one balanced reversal + replacement', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    expect((await categorize('acct-travel')).status).toBe(200);
    expect((await categorize('acct-meals')).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
    expect(h.fake.state.entries).toHaveLength(5);
  });

  it('suspense → category (the old backfill case) still moves the 6999 debit, idempotently', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    expect((await categorize('acct-travel')).status).toBe(200);
    expect(row().categoryId).toBe('acct-travel');
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
    const after = snap();
    expect((await categorize('acct-travel')).status).toBe(200);
    expect(snap().j).toEqual(after.j);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
  });

  it('closed period → 422 period_gate (PATCH shape + code), nothing written — not even the category', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });
    const before = snap();

    const { status, json } = await categorize('acct-travel');
    expect(status).toBe(422);
    expect(json).toEqual({
      success: false,
      code: 'period_closed',
      error: 'Period gate violated',
      details: { constraint: 'period_gate', year: 2026, month: 1, status: 'closed' },
    });
    expect(snap()).toEqual(before);
    expect(row().categoryId).toBe('acct-meals');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('split / multi-line entry → 422 split_entry, nothing written', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });
    const before = snap();

    const { status, json } = await categorize('acct-travel');
    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.code).toBe('split_entry');
    expect(json.error).toMatch(/split or multi-line/);
    expect(snap()).toEqual(before);
  });

  it('picking the SAME category on a split-booked expense is a 200 no-op, not a 422 (unchanged = no repost)', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });
    const before = snap();

    expect((await categorize('acct-meals')).status).toBe(200);
    expect(snap().j).toEqual(before.j);
    expect(snap().l).toEqual(before.l);
  });

  it('already-reversed entry (deleted, then restored) → 422 already_reversed, nothing written', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    // What DELETE writes, followed by Restore clearing deletedAt only.
    h.fake.state.entries.push({ id: 'je-del', tenantId: 't1', date: JAN, memo: 'DELETED', sourceType: 'expense_delete', sourceId: 'exp-1' });
    for (const l of h.fake.state.lines.filter((x: any) => x.entryId === entryId)) {
      h.fake.state.lines.push({ ...l, id: `${l.id}-del`, entryId: 'je-del', debitCents: l.creditCents, creditCents: l.debitCents });
    }
    const before = snap();

    const { status, json } = await categorize('acct-travel');
    expect(status).toBe(422);
    expect(json.code).toBe('already_reversed');
    expect(snap()).toEqual(before);
  });

  it('a soft-deleted expense is 404 and the books are not touched', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    row().deletedAt = JAN;
    const before = snap();
    expect((await categorize('acct-travel')).status).toBe(404);
    expect(snap()).toEqual(before);
  });
});

describe('an UNBOOKED expense', () => {
  it('a personal unbooked expense just gets its category: no entry of any kind', async () => {
    h.fake.state.expenses.push({
      id: 'exp-1', tenantId: 't1', amountCents: 4200, date: JAN, description: 'Coffee', status: 'pending_review',
      categoryId: 'acct-meals', isPersonal: true, journalEntryId: null, deletedAt: null, vendorId: null,
    });
    expect((await categorize('acct-travel')).status).toBe(200);
    expect(row().categoryId).toBe('acct-travel');
    expect(h.fake.state.entries).toEqual([]);
  });

  it('a business unbooked draft gets its category and is booked ONCE at it (unchanged backfill), never reposted', async () => {
    h.fake.state.expenses.push({
      id: 'exp-1', tenantId: 't1', amountCents: 4200, date: JAN, description: 'Coffee', status: 'pending_review',
      categoryId: 'acct-meals', isPersonal: false, journalEntryId: null, deletedAt: null, vendorId: null,
    });
    expect((await categorize('acct-travel')).status).toBe(200);
    expect(row().categoryId).toBe('acct-travel');
    expect(h.fake.state.entries.map((e: any) => e.sourceType)).toEqual(['expense']);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
    // retry: still one entry
    expect((await categorize('acct-travel')).status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(1);
  });
});

describe('the mobile bulk review — one refused item does not abort the batch', () => {
  it('a closed-period item is reported as that item\'s failure; the next item is still applied', async () => {
    h.fake.seedBookedExpense({ id: 'exp-closed', amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    h.fake.seedBookedExpense({ id: 'exp-open', amountCents: 3000, date: D('2026-03-10T12:00:00.000Z'), debitAccountId: 'acct-meals' });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });

    const { status, json } = await review([
      { expenseId: 'exp-closed', action: 'accept', categoryId: 'acct-travel' },
      { expenseId: 'exp-open', action: 'accept', categoryId: 'acct-travel' },
    ]);
    expect(status).toBe(200);
    expect(json.data.results).toEqual([
      { expenseId: 'exp-closed', ok: false, error: 'period_closed' },
      { expenseId: 'exp-open', ok: true },
    ]);
    expect(row('exp-closed').categoryId).toBe('acct-meals');
    expect(row('exp-open').categoryId).toBe('acct-travel');
    // closed month untouched; the open item's debit moved
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-travel': 3000, 'acct-cash': -7200 });
  });

  it('a split-entry item is split_entry, the batch carries on', async () => {
    const { entryId } = h.fake.seedBookedExpense({ id: 'exp-split', amountCents: 4200, date: JAN, debitAccountId: 'acct-meals' });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });
    h.fake.seedBookedExpense({ id: 'exp-ok', amountCents: 3000, date: JAN, debitAccountId: 'acct-meals' });

    const { json } = await review([
      { expenseId: 'exp-split', action: 'accept', categoryId: 'acct-travel' },
      { expenseId: 'exp-ok', action: 'accept', categoryId: 'acct-travel' },
    ]);
    expect(json.data.results).toEqual([
      { expenseId: 'exp-split', ok: false, error: 'split_entry' },
      { expenseId: 'exp-ok', ok: true },
    ]);
  });
});
