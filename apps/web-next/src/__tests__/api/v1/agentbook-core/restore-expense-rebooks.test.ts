/**
 * POST /agentbook-core/restore/expense/:id must put the expense back ON THE BOOKS.
 *
 * DELETE soft-deletes the row AND posts a mirror reversal of its journal entry
 * (leaving journalEntryId on the reversed entry). Restore used to clear
 * deletedAt and stop, so a restored expense reappeared in the list while the
 * ledger kept netting it to $0 — P&L, the trial balance and the tax estimate
 * all missed it. And because the delete reversal was keyed
 * ('expense_delete', <expenseId>), a SECOND delete of the restored row hit the
 * G-021 unique key inside its transaction: Postgres aborts a transaction after
 * a failed statement, so the swallowed P2002 turned the DELETE into a 500.
 *
 * These run the REAL routes + REAL ledger helpers against the stateful fake in
 * lib/__tests__/fake-ledger-db.ts (applies `where`, enforces the unique key,
 * poisons a transaction after a P2002 the way Postgres does). It cannot show
 * isolation or atomicity under concurrency — only that the written rows are right.
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
vi.mock('@/lib/agentbook-soft-delete', async (orig) => ({
  ...(await orig<typeof import('@/lib/agentbook-soft-delete')>()),
  withSoftDelete: (w: Record<string, unknown>) => w,
  parseIncludeDeleted: () => false,
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

const JAN = new Date('2026-01-15T12:00:00.000Z');
const OLD = new Date('2025-03-10T12:00:00.000Z');

async function del(id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/route');
  const res = await route.DELETE(new NextRequest('http://x/e', { method: 'DELETE' }), { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}
async function restore(id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-core/restore/[entityType]/[id]/route');
  const res = await route.POST(new NextRequest('http://x/r', { method: 'POST' }), {
    params: Promise.resolve({ entityType: 'expense', id }),
  });
  return { status: res.status, json: await res.json() };
}
async function put(body: Record<string, unknown>, id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/route');
  const res = await route.PUT(
    new NextRequest('http://x/e', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: await res.json() };
}

const expenseRow = () => h.fake.state.expenses.find((e: any) => e.id === 'exp-1');
const linesOf = (entryId: string) => h.fake.state.lines.filter((l: any) => l.entryId === entryId);
const MEALS = { 'acct-meals': 4200, 'acct-cash': -4200 };

beforeEach(() => {
  vi.clearAllMocks();
  h.fake = createFakeLedgerDb();
  h.tenant = 't1';
});

describe('restore puts a deleted expense back on the books', () => {
  it('delete → restore: P&L / trial balance see the expense again (was: nets to $0)', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    expect((await del()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({}); // deleted → off the books

    const { status, json } = await restore();

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(expenseRow().deletedAt).toBeNull();
    expect(h.fake.netByAccount()).toEqual(MEALS);
  });

  it('is append-only: the original and the delete reversal are untouched, a balanced re-booking is added and the expense points at it', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await del();
    const entriesBefore = JSON.parse(JSON.stringify(h.fake.state.entries));
    const linesBefore = JSON.parse(JSON.stringify(h.fake.state.lines));

    const { json } = await restore();

    expect(h.fake.state.entries).toHaveLength(entriesBefore.length + 1);
    // Nothing already posted was edited or removed.
    expect(JSON.parse(JSON.stringify(h.fake.state.entries.slice(0, entriesBefore.length)))).toEqual(entriesBefore);
    expect(JSON.parse(JSON.stringify(h.fake.state.lines.slice(0, linesBefore.length)))).toEqual(linesBefore);

    const fresh = h.fake.state.entries[h.fake.state.entries.length - 1];
    expect(fresh.id).not.toBe(entryId);
    expect(expenseRow().journalEntryId).toBe(fresh.id);
    expect(json.data).toMatchObject({ id: 'exp-1', entityType: 'expense', ledger: 'rebooked' });
    const ls = linesOf(fresh.id);
    expect(ls.map((l: any) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      ['acct-meals', 4200, 0],
      ['acct-cash', 0, 4200],
    ]);
    expect(fresh.tenantId).toBe('t1');
    expect(ls.every((l: any) => l.tenantId === 't1')).toBe(true); // G-009
  });

  it('delete → restore → delete again succeeds and nets to zero (was: 500 — P2002 aborted the transaction)', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await del();
    await restore();

    const second = await del();

    expect(second.status).toBe(200);
    expect(expenseRow().deletedAt).not.toBeNull();
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('survives repeated delete/restore cycles: books equal the expense after every restore, zero after every delete', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    for (let i = 0; i < 3; i++) {
      expect((await del()).status).toBe(200);
      expect(h.fake.netByAccount()).toEqual({});
      expect((await restore()).status).toBe(200);
      expect(h.fake.netByAccount()).toEqual(MEALS);
    }
  });

  it('a restored expense can be edited again — no already_reversed lock-out', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await del();
    await restore();

    const { status } = await put({ amountCents: 5200 });

    expect(status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
  });

  it('restores the month it belongs to: the original month keeps the expense, the delete month nets to zero', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await del();
    await restore();
    const jan = h.fake.netByAccountInRange(new Date('2026-01-01'), new Date('2026-02-01'));
    expect(jan).toEqual(MEALS);
    // Everything dated "now" (delete reversal + its cancellation) nets out.
    expect(h.fake.netByAccountInRange(new Date('2026-02-01'), new Date('2100-01-01'))).toEqual({});
  });

  it('delete → restore of a categorized-from-suspense / split (3-line) entry copies the lines as booked', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 1100, date: JAN });
    // Turn the seed into a 3-line entry: DR meals 1000, DR tax 100, CR cash 1100.
    const ls = h.fake.state.lines.filter((l: any) => l.entryId === entryId);
    ls[0].debitCents = 1000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 100, creditCents: 0, description: 'tax' });
    await del();
    expect(h.fake.netByAccount()).toEqual({});
    await restore();
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 1000, 'acct-tax': 100, 'acct-cash': -1100 });
  });

  it('an expense that was never booked (draft / personal) restores with no ledger activity', async () => {
    h.fake.state.expenses.push({
      id: 'exp-1', tenantId: 't1', amountCents: 900, date: JAN, description: 'x', status: 'pending_review',
      categoryId: null, isPersonal: false, journalEntryId: null, deletedAt: new Date(), vendorId: null,
    });
    const { status, json } = await restore();
    expect(status).toBe(200);
    expect(json.data.ledger).toBe('not_booked');
    expect(h.fake.state.entries).toHaveLength(0);
    expect(expenseRow().deletedAt).toBeNull();
  });

  it('an undone (rejected) expense that was also deleted stays off the books when restored', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, status: 'rejected' });
    h.fake.appendMirror(entryId, { sourceType: 'expense_amend_reversal', sourceId: entryId, memo: 'undo' });
    expenseRow().deletedAt = new Date();
    const { status, json } = await restore();
    expect(status).toBe(200);
    expect(json.data.ledger).toBe('not_booked');
    expect(h.fake.netByAccount()).toEqual({});
  });

  it("only restores within the caller's tenant", async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await del();
    h.tenant = 't2';
    expect((await restore()).status).toBe(404);
    expect(h.fake.netByAccount()).toEqual({});
    expect(expenseRow().deletedAt).not.toBeNull();
  });
});

describe('restoring an expense deleted by the OLD code (reversal keyed by expense id)', () => {
  function seedLegacyDeleted(date = JAN, reversalDate = new Date()) {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date, sourceId: null });
    h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED - Reverse expense: Coffee', date: reversalDate });
    expenseRow().deletedAt = new Date();
    return { entryId };
  }

  it('re-books it, and retires the legacy key so later edits and deletes are not blocked by it', async () => {
    seedLegacyDeleted();
    expect(h.fake.netByAccount()).toEqual({});

    expect((await restore()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual(MEALS);

    // Not locked out: the old reversal no longer counts against the NEW entry.
    expect((await put({ amountCents: 5200 })).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
    expect((await del()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('a second legacy delete (key already taken by the first) is a clean no-op reversal, not a 500', async () => {
    // Pre-fix state: restored without re-booking → pointer still on the reversed entry.
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, sourceId: null });
    h.fake.appendMirror(entryId, { sourceType: 'expense_delete', sourceId: 'exp-1', memo: 'DELETED' });
    expect(h.fake.netByAccount()).toEqual({});

    const { status } = await del();

    expect(status).toBe(200);
    expect(expenseRow().deletedAt).not.toBeNull();
    expect(h.fake.netByAccount()).toEqual({}); // NOT −$42: no second reversal
  });

  it('dates the re-booking at the reversal it cancels, so a closed delete-month is respected by falling back to today only when needed', async () => {
    seedLegacyDeleted(OLD, OLD); // deleted back in Mar 2025
    h.fake.state.periods.push({ tenantId: 't1', year: 2025, month: 3, status: 'closed' });

    const { status } = await restore();

    expect(status).toBe(200);
    const fresh = h.fake.state.entries[h.fake.state.entries.length - 1];
    // Mar 2025 is closed → re-booked today, not into the closed month.
    expect(new Date(fresh.date).getFullYear()).toBe(new Date().getFullYear());
    expect(h.fake.netByAccount()).toEqual(MEALS);
  });

  it('is refused (409) when BOTH the reversal month and today are closed — nothing changes', async () => {
    seedLegacyDeleted(OLD, OLD);
    const now = new Date();
    h.fake.state.periods.push(
      { tenantId: 't1', year: 2025, month: 3, status: 'closed' },
      { tenantId: 't1', year: now.getFullYear(), month: now.getMonth() + 1, status: 'closed' },
    );
    const before = JSON.parse(JSON.stringify(h.fake.state));

    const { status } = await restore();

    expect(status).toBe(409);
    expect(JSON.parse(JSON.stringify(h.fake.state))).toEqual(before);
    expect(expenseRow().deletedAt).not.toBeNull(); // still deleted — row and books agree
  });

  it('refuses to guess when the entry was edited after the delete (debit moved in place): restores the row, books flagged for a bookkeeper, no new entry', async () => {
    const { entryId } = seedLegacyDeleted();
    // reclassifyFromSuspense-style in-place move AFTER the delete mirrored the old lines.
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).accountId = 'acct-travel';
    const entriesBefore = h.fake.state.entries.length;

    const { status, json } = await restore();

    expect(status).toBe(200);
    expect(json.data.ledger).toBe('needs_review');
    expect(h.fake.state.entries).toHaveLength(entriesBefore);
    expect(expenseRow().deletedAt).toBeNull();
  });
});
