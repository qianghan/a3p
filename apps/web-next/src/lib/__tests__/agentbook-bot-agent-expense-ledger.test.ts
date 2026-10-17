/**
 * The Telegram bot's "actually it was $52" amount fix and its undo must move the
 * books through the SAME helpers the web edit uses (repost / unbook), inside one
 * transaction with the row change.
 *
 * They used to write a reversal and a replacement by hand, both under
 * ('expense', expenseId) — the one G-021 unique key — with no transaction:
 *   - an expense booked by the create route (no source key): the reversal
 *     committed, the replacement threw P2002, and the expense netted $0;
 *   - an expense booked by the bot's confirm path (keyed to the expense id): the
 *     reversal itself threw P2002, so neither skill worked at all.
 *
 * Runs against the stateful fake (applies `where`, enforces the unique key,
 * poisons a transaction after a P2002 as Postgres does). It cannot demonstrate
 * isolation under concurrency; it does show every written row is right and
 * that a failed step leaves the row AND the books as they were.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ fake: null as any }));

vi.mock('@naap/database', () => ({
  prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }),
}));
vi.mock('@/lib/agentbook-account-resolver', () => ({
  resolveVehicleAccounts: vi.fn(async () => null),
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import { executeStep, type BotContext, type ActiveExpense } from '../agentbook-bot-agent';

const JAN = new Date('2026-01-15T12:00:00.000Z');
const row = () => h.fake.state.expenses.find((e: any) => e.id === 'exp-1');

function active(): ActiveExpense {
  const r = row();
  return {
    id: r.id, amountCents: r.amountCents, currency: 'USD', date: r.date, description: r.description,
    vendorName: 'Tea', vendorId: null, categoryId: r.categoryId, categoryName: null,
    isPersonal: r.isPersonal, status: r.status,
  };
}
const ctx = (): BotContext => ({ tenantId: 't1', active: active(), categories: [] } as unknown as BotContext);
const amountFix = (amountCents: number) =>
  executeStep({ id: 's', skill: 'expense.update_amount', args: { amountCents }, dependsOn: [] }, ctx());
const undo = () => executeStep({ id: 's', skill: 'expense.undo_last', args: {}, dependsOn: [] }, ctx());
const snap = () => JSON.parse(JSON.stringify({
  expenses: h.fake.state.expenses, entries: h.fake.state.entries, lines: h.fake.state.lines,
}));
const balanced = () => {
  for (const e of h.fake.state.entries) {
    const ls = h.fake.state.lines.filter((l: any) => l.entryId === e.id);
    expect(ls.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(ls.reduce((s: number, l: any) => s + l.creditCents, 0));
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fake = createFakeLedgerDb();
});

describe.each([
  ['create-route booked (no source key)', null],
  ["bot-confirm booked (keyed to the expense id)", undefined],
] as const)('expense.update_amount — %s', (_label, sourceId) => {
  const seed = (extra: Record<string, unknown> = {}) =>
    h.fake.seedBookedExpense({ amountCents: 2500, date: JAN, ...(sourceId === null ? { sourceId: null } : {}), ...extra });

  it('moves the books to the new amount and the row follows (was: books netted $0 / the step threw)', async () => {
    seed();
    const res = await amountFix(5200);

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ previousAmount: 2500, newAmount: 5200 });
    expect(row().amountCents).toBe(5200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
    balanced();
  });

  it('survives repeated corrections (each repost gets a fresh key)', async () => {
    seed();
    for (const amt of [5200, 6100, 2500, 9900]) {
      expect((await amountFix(amt)).success).toBe(true);
      expect(h.fake.netByAccount()).toEqual({ 'acct-meals': amt, 'acct-cash': -amt });
    }
  });

  it('keeps an UNCATEGORIZED expense on the suspense account', async () => {
    seed({ debitAccountId: 'acct-suspense', categoryId: null });
    expect((await amountFix(5200)).success).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 5200, 'acct-cash': -5200 });
  });

  it('never edits a posted entry: the original lines are untouched', async () => {
    const { entryId } = seed();
    await amountFix(5200);
    expect(h.fake.state.lines.filter((l: any) => l.entryId === entryId).map((l: any) => [l.debitCents, l.creditCents]))
      .toEqual([[2500, 0], [0, 2500]]);
  });

  it('a correction followed by an undo nets the expense to zero', async () => {
    seed();
    await amountFix(5200);
    expect((await undo()).success).toBe(true);
    expect(h.fake.netByAccount()).toEqual({});
    expect(row().status).toBe('rejected');
  });

  it('a period-closed month fails the step and leaves the row AND the books unchanged', async () => {
    seed();
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });
    const before = snap();

    const res = await amountFix(5200);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/closed/i);
    expect(snap()).toEqual(before);
  });

  it('refuses when the current entry was already reversed (orphan): books and row unchanged, user told why', async () => {
    const { entryId } = seed();
    // Pre-fix orphan: the old fix committed its reversal then failed the replacement.
    h.fake.state.entries.find((e: any) => e.id === entryId).sourceId = null;
    h.fake.appendMirror(entryId, { sourceType: 'expense', sourceId: 'exp-1', memo: 'REVERSAL: Expense: Coffee (amount fix)' });
    const before = snap();

    const res = await amountFix(5200);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already reversed/i);
    expect(snap()).toEqual(before);
  });
});

describe('expense.update_amount — other shapes', () => {
  it('only patches the amount when the expense never reached the ledger', async () => {
    h.fake.state.expenses.push({
      id: 'exp-1', tenantId: 't1', amountCents: 2500, date: JAN, description: 'Coffee', status: 'confirmed',
      categoryId: null, isPersonal: false, journalEntryId: null, deletedAt: null, vendorId: null,
    });
    expect((await amountFix(5200)).success).toBe(true);
    expect(row().amountCents).toBe(5200);
    expect(h.fake.state.entries).toHaveLength(0);
  });

  it('an unchanged amount is a no-op', async () => {
    h.fake.seedBookedExpense({ amountCents: 2500, date: JAN });
    const before = snap();
    const res = await amountFix(2500);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ unchanged: true });
    expect(snap()).toEqual(before);
  });

  it('a personal expense just patches the amount (nothing is booked)', async () => {
    h.fake.state.expenses.push({
      id: 'exp-1', tenantId: 't1', amountCents: 2500, date: JAN, description: 'x', status: 'confirmed',
      categoryId: null, isPersonal: true, journalEntryId: null, deletedAt: null, vendorId: null,
    });
    expect((await amountFix(900)).success).toBe(true);
    expect(row().amountCents).toBe(900);
    expect(h.fake.state.entries).toHaveLength(0);
  });

  it('records the expense.amount_updated event', async () => {
    h.fake.seedBookedExpense({ amountCents: 2500, date: JAN, sourceId: null });
    await amountFix(5200);
    expect(h.fake.state.events.map((e: any) => e.eventType)).toEqual(['expense.amount_updated']);
  });
});

describe.each([
  ['create-route booked (no source key)', null],
  ["bot-confirm booked (keyed to the expense id)", undefined],
] as const)('expense.undo_last — %s', (_label, sourceId) => {
  const seed = (extra: Record<string, unknown> = {}) =>
    h.fake.seedBookedExpense({ amountCents: 2500, date: JAN, ...(sourceId === null ? { sourceId: null } : {}), ...extra });

  it('takes the money off the books and rejects the expense (was: threw P2002 for bot-confirm entries)', async () => {
    seed();
    const res = await undo();

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ previousStatus: 'confirmed', amountCents: 2500 });
    expect(row().status).toBe('rejected');
    expect(h.fake.netByAccount()).toEqual({});
    balanced();
  });

  it('works for an UNCATEGORIZED expense booked to suspense', async () => {
    seed({ debitAccountId: 'acct-suspense', categoryId: null });
    expect((await undo()).success).toBe(true);
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('a second undo is a no-op (already rejected) and does not double-reverse', async () => {
    seed();
    await undo();
    const before = snap();
    const res = await undo();
    expect(res.data).toMatchObject({ wasAlready: true });
    expect(snap()).toEqual(before);
  });

  it('a closed period fails the step and leaves the status AND the books unchanged', async () => {
    seed();
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });
    const before = snap();
    const res = await undo();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/closed/i);
    expect(snap()).toEqual(before);
  });

  it('an expense whose books were ALREADY reversed (orphan) is just marked rejected — no second reversal', async () => {
    const { entryId } = seed();
    h.fake.state.entries.find((e: any) => e.id === entryId).sourceId = null;
    h.fake.appendMirror(entryId, { sourceType: 'expense', sourceId: 'exp-1', memo: 'REVERSAL: Expense: Coffee (amount fix)' });
    const entries = h.fake.state.entries.length;

    const res = await undo();

    expect(res.success).toBe(true);
    expect(row().status).toBe('rejected');
    expect(h.fake.state.entries).toHaveLength(entries); // nothing added
    expect(h.fake.netByAccount()).toEqual({}); // NOT −$25
  });

  it('deleting an undone expense afterwards does not reverse it again', async () => {
    seed();
    await undo();
    const { reverseExpenseJournalEntry } = await import('../agentbook-expense-ledger');
    const r = await reverseExpenseJournalEntry('t1', 'exp-1');
    expect(r.reversed).toBe(false);
    expect(h.fake.netByAccount()).toEqual({});
  });
});
