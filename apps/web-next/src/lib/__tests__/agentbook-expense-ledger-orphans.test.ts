/**
 * findOrphanedExpenseReversals — the read-only scan behind
 * bin/repair-orphaned-expense-reversals.ts.
 *
 * An "orphan" is a LIVE, confirmed, business expense whose current journal entry
 * has already been reversed, so it shows in the user's list while the books net
 * it to $0. Two producers exist in production data:
 *   - Restore before it re-booked (DELETE's reversal stayed on the entry);
 *   - the Telegram bot's old amount fix (reversal committed, replacement failed).
 *
 * The scan must report exactly those, and nothing else: a false positive would
 * have the repair post money for an expense that is correctly off the books.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ fake: null as any }));
vi.mock('@naap/database', () => ({
  prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }),
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(),
  ensureUncategorizedAccount: vi.fn(),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import {
  findOrphanedExpenseReversals,
  rebookReversedExpenseEntry,
  reverseExpenseJournalEntry,
} from '../agentbook-expense-ledger';

const JAN = new Date('2026-01-15T12:00:00.000Z');
const scan = (tenantId?: string) => findOrphanedExpenseReversals(h.fake.db as any, { tenantId });
const seedExpense = (id: string, extra: Record<string, unknown> = {}, tenantId = 't1') => {
  const { entryId } = h.fake.seedBookedExpense({ id, tenantId, amountCents: 4200, date: JAN, sourceId: null, ...extra });
  return entryId;
};

beforeEach(() => {
  h.fake = createFakeLedgerDb();
});

describe('findOrphanedExpenseReversals', () => {
  it('finds a delete-then-restore row left un-rebooked by the OLD restore (legacy delete key)', async () => {
    const entryId = seedExpense('exp-1');
    const rev = h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    expect(h.fake.netByAccount()).toEqual({});

    const found = await scan();

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      tenantId: 't1', expenseId: 'exp-1', amountCents: 4200, entryId, reversalId: rev.entryId,
      reversalType: 'expense_delete', legacy: true, outcome: 'rebookable',
    });
  });

  it('finds a restored row whose reversal is keyed by ENTRY id (deleted by the new code, restored by the old)', async () => {
    seedExpense('exp-1');
    expect((await reverseExpenseJournalEntry('t1', 'exp-1')).reversed).toBe(true);
    h.fake.restoreExpense();
    const found = await scan();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ expenseId: 'exp-1', legacy: false, reversalType: 'expense_delete', outcome: 'rebookable' });
  });

  it("finds the bot's orphaned amount-fix reversal (no replacement) on a create-route entry", async () => {
    const entryId = seedExpense('exp-1');
    h.fake.appendMirror(entryId, { sourceType: 'expense', sourceId: 'exp-1', memo: 'REVERSAL: Expense: Coffee (amount fix)' });
    const found = await scan();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ expenseId: 'exp-1', legacy: true, reversalType: 'expense', outcome: 'rebookable' });
  });

  it('does NOT report a deleted expense — being off the books is correct for it', async () => {
    const entryId = seedExpense('exp-1');
    h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    h.fake.state.expenses[0].deletedAt = new Date();
    expect(await scan()).toEqual([]);
  });

  it('does NOT report an undone (rejected) or personal expense', async () => {
    const a = seedExpense('exp-1', { status: 'rejected' });
    h.fake.appendMirror(a, { sourceType: 'expense', sourceId: 'exp-1', memo: 'REVERSAL: Expense: Coffee' });
    const b = seedExpense('exp-2', { isPersonal: true });
    h.fake.appendMirror(b, { sourceType: 'expense_delete', sourceId: 'exp-2', memo: 'DELETED' });
    expect(await scan()).toEqual([]);
  });

  it('does NOT report a healthy expense, or one whose edit history has amend reversals on SUPERSEDED entries', async () => {
    seedExpense('exp-ok');
    const old = seedExpense('exp-edited');
    // an edit: superseded entry reversed, pointer moved to a live replacement
    h.fake.appendMirror(old, { sourceType: 'expense_amend_reversal', sourceId: old, memo: 'AMENDED' });
    const { entryId: live } = h.fake.seedBookedExpense({ id: 'exp-edited-live', amountCents: 5000, date: JAN, sourceId: null });
    h.fake.state.expenses.find((e: any) => e.id === 'exp-edited').journalEntryId = live;
    expect(await scan()).toEqual([]);
  });

  it('classifies an entry edited AFTER the delete (debit moved in place) as needs_review, not rebookable', async () => {
    const entryId = seedExpense('exp-1');
    h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).accountId = 'acct-travel';
    const found = await scan();
    expect(found).toHaveLength(1);
    expect(found[0].outcome).toBe('needs_review');
  });

  it('honours the tenant filter and never crosses tenants', async () => {
    const e1 = seedExpense('exp-1');
    h.fake.appendMirror(e1, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    const e2 = seedExpense('exp-2', {}, 't2');
    h.fake.appendMirror(e2, { sourceType: 'expense_delete', sourceId: 'exp-2', memo: 'DELETED' });

    expect((await scan()).map((o) => o.expenseId).sort()).toEqual(['exp-1', 'exp-2']);
    expect((await scan('t2')).map((o) => o.expenseId)).toEqual(['exp-2']);
  });

  it('is READ-ONLY: scanning writes nothing', async () => {
    const entryId = seedExpense('exp-1');
    h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    const before = JSON.stringify(h.fake.state);
    await scan();
    expect(JSON.stringify(h.fake.state)).toBe(before);
  });
});

describe('repairing what the scan found', () => {
  it('re-booking each rebookable orphan puts the books back and the next scan is empty (idempotent)', async () => {
    const a = seedExpense('exp-1');
    h.fake.appendMirror(a, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    const b = seedExpense('exp-2', { amountCents: 900 });
    h.fake.appendMirror(b, { sourceType: 'expense', sourceId: 'exp-2', memo: 'REVERSAL: Expense: Coffee (amount fix)' });
    expect(h.fake.netByAccount()).toEqual({});

    for (const o of await scan()) {
      const r = await h.fake.db.$transaction((tx: any) => rebookReversedExpenseEntry(o.tenantId, o.expenseId, tx));
      expect(r.outcome).toBe('rebooked');
    }

    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5100, 'acct-cash': -5100 });
    expect(await scan()).toEqual([]);
  });

  it('a second rebook of the same expense is a no-op, never a double booking', async () => {
    const a = seedExpense('exp-1');
    h.fake.appendMirror(a, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    const run = () => h.fake.db.$transaction((tx: any) => rebookReversedExpenseEntry('t1', 'exp-1', tx));
    expect((await run()).outcome).toBe('rebooked');
    expect((await run()).outcome).toBe('already_on_books');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });
});
