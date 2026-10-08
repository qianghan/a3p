/**
 * PUT/PATCH /expenses/:id — editing a BOOKED expense must keep the ledger honest.
 *
 * The route used to patch the expense row and stop. For an expense that already
 * had a journal entry, changing amountCents or date left the books at the OLD
 * figure: the list showed $52, P&L and the tax estimate kept counting $42, and
 * nothing anywhere flagged the disagreement.
 *
 * These tests run the REAL route + the REAL ledger helper against a stateful
 * in-memory DB (see fake-ledger-db.ts) that applies `where`, enforces the G-021
 * unique constraint and rolls back failed transactions — so they can fail on a
 * wrong filter, a rejected insert or a half-applied edit, which a vi.fn() script
 * cannot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ fake: null as any, tenant: 't1', audit: vi.fn(async () => {}) }));

vi.mock('@naap/database', () => ({
  prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }),
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: h.tenant })),
}));
vi.mock('@/lib/agentbook-audit', () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock('@/lib/agentbook-audit-context', () => ({
  inferSource: () => 'test',
  inferActor: async () => 'test-actor',
}));
vi.mock('@/lib/agentbook-soft-delete', () => ({
  withSoftDelete: (w: Record<string, unknown>) => w,
  parseIncludeDeleted: () => false,
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

const D = (s: string) => new Date(s);
const JAN = D('2026-01-15T12:00:00.000Z');

async function put(body: Record<string, unknown>, id = 'exp-1', method: 'PUT' | 'PATCH' = 'PUT') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/route');
  const res = await route[method](
    new NextRequest(`http://x/api/v1/agentbook-expense/expenses/${id}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: await res.json() };
}

async function del(id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/route');
  return route.DELETE(new NextRequest('http://x/e', { method: 'DELETE' }), { params: Promise.resolve({ id }) });
}

const expenseRow = () => h.fake.state.expenses.find((e: any) => e.id === 'exp-1');

beforeEach(() => {
  vi.clearAllMocks();
  h.fake = createFakeLedgerDb();
  h.tenant = 't1';
});

describe('amount edit on a booked expense', () => {
  it('moves the books to the new amount — P&L matches the edited expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await put({ amountCents: 5200 });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(expenseRow().amountCents).toBe(5200);
    // The ledger — not just the expense row — now says $52.
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
  });

  it('never edits a posted entry: original is untouched, a reversal + replacement are appended', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await put({ amountCents: 5200 });

    const { entries, lines } = h.fake.state;
    expect(entries).toHaveLength(3);
    const original = lines.filter((l: any) => l.entryId === entryId);
    expect(original.map((l: any) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      ['acct-meals', 4200, 0],
      ['acct-cash', 0, 4200],
    ]);
    // every entry balances
    for (const e of entries) {
      const ls = lines.filter((l: any) => l.entryId === e.id);
      expect(ls.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(
        ls.reduce((s: number, l: any) => s + l.creditCents, 0),
      );
    }
  });

  it('points the expense at the replacement entry, and returns it in the response', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { json } = await put({ amountCents: 5200 });

    expect(expenseRow().journalEntryId).not.toBe(entryId);
    expect(json.data.journalEntryId).toBe(expenseRow().journalEntryId);
    // Response shape is the updated expense row, as before.
    expect(json.data).toMatchObject({ id: 'exp-1', amountCents: 5200, tenantId: 't1' });
  });

  it('re-posts against whatever the original debited (a suspense booking stays on suspense)', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    await put({ amountCents: 5200 });
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 5200, 'acct-cash': -5200 });
  });

  it('PATCH behaves exactly like PUT', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await put({ amountCents: 5200 }, 'exp-1', 'PATCH');
    expect(status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
  });

  it('survives repeated edits (each repost needs a fresh unique source key) and a delete nets to zero', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    for (const amt of [5200, 6100, 4200, 7000]) {
      const { status } = await put({ amountCents: amt });
      expect(status).toBe(200);
      expect(h.fake.netByAccount()).toEqual({ 'acct-meals': amt, 'acct-cash': -amt });
    }
    const res = await del();
    expect(res.status).toBe(200);
    // delete reverses the CURRENT entry — the whole chain nets to nothing
    expect(h.fake.netByAccount()).toEqual({});
  });
});

describe('date edit on a booked expense', () => {
  it('moves the cost between periods: the old month nets to zero, the new month carries it', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await put({ date: '2026-03-10T12:00:00.000Z' });

    expect(status).toBe(200);
    expect(h.fake.netByAccountInRange(D('2026-01-01'), D('2026-02-01'))).toEqual({});
    expect(h.fake.netByAccountInRange(D('2026-03-01'), D('2026-04-01'))).toEqual({
      'acct-meals': 4200,
      'acct-cash': -4200,
    });
  });

  it('dates the reversal at the ORIGINAL date, not "today" — otherwise January keeps the expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await put({ date: '2026-03-10T12:00:00.000Z' });
    const reversal = h.fake.state.entries.find((e: any) => e.sourceType === 'expense_amend_reversal');
    expect(reversal.date.getTime()).toBe(JAN.getTime());
  });

  it('a date-only edit keeps the entry shape, including a multi-line (tax) entry', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    // Turn the original into a 3-line entry: 4000 expense + 200 tax-paid / 4200 cash.
    const lines = h.fake.state.lines.filter((l: any) => l.entryId === entryId);
    lines[0].debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });

    const { status } = await put({ date: '2026-03-10T12:00:00.000Z' });
    expect(status).toBe(200);
    expect(h.fake.netByAccountInRange(D('2026-03-01'), D('2026-04-01'))).toEqual({
      'acct-meals': 4000,
      'acct-tax': 200,
      'acct-cash': -4200,
    });
  });
});

describe('amount + date together', () => {
  it('lands the NEW amount in the NEW period and nothing in the old one', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await put({ amountCents: 9900, date: '2026-03-10T12:00:00.000Z' });
    expect(h.fake.netByAccountInRange(D('2026-01-01'), D('2026-02-01'))).toEqual({});
    expect(h.fake.netByAccountInRange(D('2026-03-01'), D('2026-04-01'))).toEqual({
      'acct-meals': 9900,
      'acct-cash': -9900,
    });
  });
});

describe('edits that must NOT touch the ledger', () => {
  it.each([
    ['description only', { description: 'Latte' }],
    ['isPersonal sent but unchanged', { isPersonal: false }],
    ['category sent but unchanged', { categoryId: 'acct-meals' }],
    ['vendor only', { vendor: 'Blue Bottle' }],
    ['amount sent but unchanged', { amountCents: 4200 }],
    ['date sent but on the same day', { date: '2026-01-15T12:00:00.000Z' }],
  ])('%s', async (_name, body) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await put(body);
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(1);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('an expense that was never booked gets no journal entry from an amount edit', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.entries.length = 0;
    h.fake.state.lines.length = 0;
    expenseRow().journalEntryId = null;

    const { status } = await put({ amountCents: 5200 });
    expect(status).toBe(200);
    expect(expenseRow().amountCents).toBe(5200);
    expect(h.fake.state.entries).toHaveLength(0);
  });

  it('a rejected expense (already reversed by undo) is not resurrected into the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, status: 'rejected' });
    const { status } = await put({ amountCents: 5200 });
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(1);
  });
});

describe('guards', () => {
  it('refuses to rewrite a CLOSED period (original month) and leaves expense + books untouched', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });

    const { status, json } = await put({ amountCents: 5200 });

    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.details?.constraint).toBe('period_gate');
    expect(expenseRow().amountCents).toBe(4200); // the expense edit rolled back too
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('refuses to move an expense INTO a closed period', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 3, status: 'closed' });

    const { status, json } = await put({ date: '2026-03-10T12:00:00.000Z' });

    expect(status).toBe(422);
    expect(json.details?.constraint).toBe('period_gate');
    expect(h.fake.state.entries).toHaveLength(1);
    expect(expenseRow().date.getTime()).toBe(JAN.getTime());
  });

  it('a closed period does not block edits that cannot change the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });
    const { status } = await put({ description: 'Latte' });
    expect(status).toBe(200);
  });

  it('refuses an amount change on a split-shaped entry rather than inventing a split', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });

    const { status, json } = await put({ amountCents: 5200 });

    expect(status).toBe(422);
    expect(json.error).toMatch(/split|multi/i);
    expect(expenseRow().amountCents).toBe(4200);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('a concurrent edit that already reversed this entry yields 409 and applies nothing', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    // The other request committed its reversal but this request still sees the old pointer.
    h.fake.state.entries.push({
      id: 'je-other', tenantId: 't1', date: JAN, memo: 'x', sourceType: 'expense_amend_reversal', sourceId: entryId,
    });

    const { status } = await put({ amountCents: 5200 });

    expect(status).toBe(409);
    expect(expenseRow().amountCents).toBe(4200);
  });

  it("another tenant's expense is a 404, not an edit", async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, tenantId: 't2' });
    const { status } = await put({ amountCents: 5200 });
    expect(status).toBe(404);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it.each([[0], [-300], [12.5], ['42']])('rejects amountCents=%s with 400 and changes nothing', async (bad) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await put({ amountCents: bad });
    expect(status).toBe(400);
    expect(expenseRow().amountCents).toBe(4200);
  });

  it('rejects an unparseable date with 400', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await put({ date: 'not-a-date' });
    expect(status).toBe(400);
  });
});

describe('audit', () => {
  it('still records only the fields the caller touched', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await put({ amountCents: 5200 });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'expense.update',
        before: { amountCents: 4200 },
        after: { amountCents: 5200 },
      }),
    );
  });
});

describe('INVARIANT: after any edit sequence the ledger equals the expense', () => {
  const sequences: Array<Array<Record<string, unknown>>> = [
    [{ amountCents: 1 }],
    [{ amountCents: 999999 }],
    [{ date: '2025-12-31T23:00:00.000Z' }],
    [{ amountCents: 5000, date: '2026-02-02T09:00:00.000Z' }, { amountCents: 100 }, { date: '2026-01-15T12:00:00.000Z' }],
    [{ description: 'x' }, { amountCents: 4300 }, { isPersonal: false }, { date: '2026-06-30T12:00:00.000Z' }, { amountCents: 4200 }],
  ];

  it.each(sequences.map((s, i) => [i, s] as const))('sequence #%i', async (_i, seq) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    for (const edit of seq) {
      const { status } = await put(edit);
      expect(status).toBe(200);

      const exp = expenseRow();
      // 1. total books == the expense, by account
      expect(h.fake.netByAccount()).toEqual({ 'acct-meals': exp.amountCents, 'acct-cash': -exp.amountCents });
      // 2. ...and all of it sits in the expense's own month, none left in any other
      const from = new Date(Date.UTC(exp.date.getUTCFullYear(), exp.date.getUTCMonth(), 1));
      const to = new Date(Date.UTC(exp.date.getUTCFullYear(), exp.date.getUTCMonth() + 1, 1));
      expect(h.fake.netByAccountInRange(from, to)).toEqual({ 'acct-meals': exp.amountCents, 'acct-cash': -exp.amountCents });
      // 3. the pointer references an entry that exists and balances to the amount
      const lines = h.fake.state.lines.filter((l: any) => l.entryId === exp.journalEntryId);
      expect(lines.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(exp.amountCents);
    }
  });
});
