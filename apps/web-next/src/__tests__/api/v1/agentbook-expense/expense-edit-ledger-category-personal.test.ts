/**
 * PUT/PATCH /expenses/:id — the edits beyond amount/date that move money on the
 * books, and the merge with main's (#581) date + vendor handling.
 *
 *   - categoryId on a BOOKED expense: validated (tenant's active expense
 *     account), then the debit is reversed off the old account and re-posted
 *     on the new one. Clearing it sends the debit back to 6999 suspense.
 *   - isPersonal business → personal: the entry is reversed and unlinked.
 *   - isPersonal personal → business (confirmed, unbooked): the entry is posted.
 *
 * Same harness as expense-edit-reposts-ledger.test.ts: the REAL route and the
 * REAL ledger helpers against fake-ledger-db, which applies `where`, enforces
 * the G-021 unique key and ROLLS BACK a failed $transaction — so "nothing was
 * written" assertions below are meaningful. It does NOT model Postgres row
 * locks; the concurrency tests simulate interleavings explicitly.
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

async function send(body: Record<string, unknown>, method: 'PUT' | 'PATCH' = 'PATCH', id = 'exp-1') {
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
const entriesOf = (sourceType: string) => h.fake.state.entries.filter((e: any) => e.sourceType === sourceType);
const linesOf = (entryId: string) => h.fake.state.lines.filter((l: any) => l.entryId === entryId);

function expectEveryEntryBalanced() {
  for (const e of h.fake.state.entries) {
    const ls = linesOf(e.id);
    expect(ls.length, `entry ${e.id} has no lines`).toBeGreaterThan(0);
    expect(ls.reduce((s: number, l: any) => s + l.debitCents, 0), `entry ${e.id} unbalanced`).toBe(
      ls.reduce((s: number, l: any) => s + l.creditCents, 0),
    );
  }
}

/** Seed a CONFIRMED expense with no journal entry (personal, or never booked). */
function seedUnbooked(opts: { isPersonal?: boolean; categoryId?: string | null; status?: string; amountCents?: number } = {}) {
  h.fake.state.expenses.push({
    id: 'exp-1', tenantId: 't1', amountCents: opts.amountCents ?? 4200, date: JAN, description: 'Coffee',
    status: opts.status ?? 'confirmed', categoryId: opts.categoryId === undefined ? 'acct-meals' : opts.categoryId,
    isPersonal: opts.isPersonal ?? true, journalEntryId: null, deletedAt: null, vendorId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fake = createFakeLedgerDb();
  h.tenant = 't1';
});

describe('category change on a booked expense', () => {
  it('moves the debit to the new account: the old category nets to zero', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await send({ categoryId: 'acct-travel' });

    expect(status).toBe(200);
    expect(json.data.categoryId).toBe('acct-travel');
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 4200, 'acct-cash': -4200 });
    expect(entriesOf('expense_amend_reversal')).toHaveLength(1);
    expect(entriesOf('expense_amend')).toHaveLength(1);
    expect(json.data.journalEntryId).toBe(entriesOf('expense_amend')[0].id);
    expectEveryEntryBalanced();
  });

  it('category + amount in one request is ONE reversal and ONE replacement, on the new account at the new amount', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await send({ categoryId: 'acct-travel', amountCents: 9900 });
    expect(entriesOf('expense_amend_reversal')).toHaveLength(1);
    expect(entriesOf('expense_amend')).toHaveLength(1);
    expect(h.fake.netByAccount()).toEqual({ 'acct-travel': 9900, 'acct-cash': -9900 });
  });

  it('moves a suspense booking onto the category it gains', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    await send({ categoryId: 'acct-meals' });
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it.each([null, ''])('clearing the category (%j) sends the debit back to suspense', async (cleared) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await send({ categoryId: cleared });
    expect(status).toBe(200);
    expect(expenseRow().categoryId).toBeNull();
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 4200, 'acct-cash': -4200 });
  });

  it.each([
    ["another tenant's account", 'acct-t2-meals'],
    ['an inactive expense account', 'acct-old'],
    ['a non-expense account', 'acct-revenue'],
    ['an unknown id', 'acct-nope'],
    ['a non-string', 42],
  ])('rejects %s with 400 invalid_category and writes nothing', async (_name, bad) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await send({ categoryId: bad, amountCents: 5000 });
    expect(status).toBe(400);
    expect(json.code).toBe('invalid_category');
    expect(expenseRow()).toMatchObject({ categoryId: 'acct-meals', amountCents: 4200 });
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('does not re-validate an unchanged categoryId (a form re-sending the current value keeps working)', async () => {
    // Legacy row whose stored category is not a valid account any more.
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, categoryId: 'acct-old', debitAccountId: 'acct-old' });
    const { status } = await send({ categoryId: 'acct-old', description: 'Latte' });
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('refuses a category change on a multi-line entry (422) and rolls the whole edit back', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 4000;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 200, creditCents: 0 });

    const { status, json } = await send({ categoryId: 'acct-travel', vendor: 'Blue Bottle' });
    expect(status).toBe(422);
    expect(json.error).toMatch(/split|multi/i);
    expect(expenseRow()).toMatchObject({ categoryId: 'acct-meals', vendorId: null });
    expect(h.fake.state.entries).toHaveLength(1);
    expect(h.fake.state.vendors).toHaveLength(0); // the vendor upsert rolled back too
  });

  it('a category change on a never-booked expense posts nothing', async () => {
    seedUnbooked({ isPersonal: false, status: 'pending_review' });
    const { status } = await send({ categoryId: 'acct-travel' });
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(0);
  });
});

describe('isPersonal flip', () => {
  it('business → personal reverses the entry at its ORIGINAL date and unlinks it', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await send({ isPersonal: true });

    expect(status).toBe(200);
    expect(json.data).toMatchObject({ isPersonal: true, journalEntryId: null });
    expect(h.fake.netByAccount()).toEqual({});
    const [rev] = entriesOf('expense_amend_reversal');
    expect(rev).toMatchObject({ sourceId: entryId });
    expect(rev.date.getTime()).toBe(JAN.getTime());
    expect(h.fake.netByAccountInRange(D('2026-01-01'), D('2026-02-01'))).toEqual({});
    expectEveryEntryBalanced();
  });

  it('business → personal with an amount change in the same request takes ALL of it off the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await send({ isPersonal: true, amountCents: 9000 });
    expect(h.fake.netByAccount()).toEqual({});
    expect(h.fake.state.entries).toHaveLength(2); // original + its reversal, no replacement
  });

  it('personal → business on a confirmed expense books it to its category, at its amount and date', async () => {
    seedUnbooked({ isPersonal: true, categoryId: 'acct-meals' });
    const { status, json } = await send({ isPersonal: false });

    expect(status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
    const [je] = h.fake.state.entries;
    expect(je.date.getTime()).toBe(JAN.getTime());
    expect(json.data.journalEntryId).toBe(je.id);
    expect(expenseRow().journalEntryId).toBe(je.id);
  });

  it('personal → business with no category books to 6999 suspense (never skipped)', async () => {
    seedUnbooked({ isPersonal: true, categoryId: null });
    await send({ isPersonal: false });
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 4200, 'acct-cash': -4200 });
  });

  it('personal → business with an invalid stored category books to suspense, not to that account', async () => {
    seedUnbooked({ isPersonal: true, categoryId: 'acct-t2-meals' });
    await send({ isPersonal: false });
    expect(h.fake.netByAccount()).toEqual({ 'acct-suspense': 4200, 'acct-cash': -4200 });
  });

  it('personal → business on a pending_review draft books nothing (confirm / categorize book drafts)', async () => {
    seedUnbooked({ isPersonal: true, status: 'pending_review' });
    const { status } = await send({ isPersonal: false });
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(0);
  });

  it('round trip business → personal → business, then delete: every step agrees with the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await send({ isPersonal: true });
    expect(h.fake.netByAccount()).toEqual({});
    await send({ isPersonal: false, amountCents: 5100 });
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5100, 'acct-cash': -5100 });
    await send({ isPersonal: true });
    expect(h.fake.netByAccount()).toEqual({});
    await send({ isPersonal: false });
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5100, 'acct-cash': -5100 });
    expect((await del()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({});
    expectEveryEntryBalanced();
  });

  it('business → personal in a CLOSED month is a 422 and nothing changes', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 1, status: 'closed' });
    const { status, json } = await send({ isPersonal: true });
    expect(status).toBe(422);
    expect(json.details?.constraint).toBe('period_gate');
    expect(expenseRow()).toMatchObject({ isPersonal: false });
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('a rejected (undone) expense is never re-booked by a flip', async () => {
    seedUnbooked({ isPersonal: true, status: 'rejected' });
    await send({ isPersonal: false });
    expect(h.fake.state.entries).toHaveLength(0);
  });

  it.each([['true'], [1], [null]])('rejects isPersonal=%j with 400', async (bad) => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await send({ isPersonal: bad });
    expect(status).toBe(400);
    expect(h.fake.state.entries).toHaveLength(1);
  });
});

describe('merged with main: vendor + strict dates on the same route', () => {
  it('PATCH vendor + amount on a booked expense: one balanced reversal + repost pair, and the right vendor', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await send({ vendor: 'Blue Bottle', amountCents: 5300 });

    expect(status).toBe(200);
    expect(json.data.vendorName).toBe('Blue Bottle');
    expect(h.fake.state.vendors).toEqual([expect.objectContaining({ name: 'Blue Bottle', normalizedName: 'bluebottle', tenantId: 't1' })]);
    expect(expenseRow().vendorId).toBe(h.fake.state.vendors[0].id);

    const reversals = entriesOf('expense_amend_reversal');
    const replacements = entriesOf('expense_amend');
    expect(reversals).toHaveLength(1);
    expect(replacements).toHaveLength(1);
    expect(reversals[0].sourceId).toBe(entryId);
    expect(replacements[0].sourceId).toBe(entryId);
    expect(h.fake.state.entries).toHaveLength(3);
    expectEveryEntryBalanced();
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5300, 'acct-cash': -5300 });
    expect(json.data.journalEntryId).toBe(replacements[0].id);
  });

  it('a non-Latin vendor name is linked (Unicode key) and does not touch the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status, json } = await send({ vendor: '星巴克' });
    expect(status).toBe(200);
    expect(json.data.vendorName).toBe('星巴克');
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it("vendor '' clears the link; punctuation-only is a 400 that writes nothing", async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    await send({ vendor: 'Blue Bottle' });
    expect(expenseRow().vendorId).not.toBeNull();
    await send({ vendor: '' });
    expect(expenseRow().vendorId).toBeNull();

    const { status } = await send({ vendor: '!!!', amountCents: 9999 });
    expect(status).toBe(400);
    expect(expenseRow().amountCents).toBe(4200);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it.each(['2026-02-30', 'June 1', '2026-1-5', '20260105'])(
    'an invalid date %j is a 400 before ANY write (expense, vendor, ledger)',
    async (bad) => {
      h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
      const { status } = await send({ date: bad, amountCents: 5000, vendor: 'Blue Bottle' });
      expect(status).toBe(400);
      expect(expenseRow()).toMatchObject({ amountCents: 4200, vendorId: null });
      expect(h.fake.state.entries).toHaveLength(1);
      expect(h.fake.state.vendors).toHaveLength(0);
    },
  );

  it('a real leap day (date-only) moves the cost into that month', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const { status } = await send({ date: '2028-02-29' });
    expect(status).toBe(200);
    expect(expenseRow().date).toEqual(D('2028-02-29'));
    expect(h.fake.netByAccountInRange(D('2028-02-01'), D('2028-03-01'))).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
    expect(h.fake.netByAccountInRange(D('2026-01-01'), D('2026-02-01'))).toEqual({});
  });
});

describe('races', () => {
  it('a DELETE that commits between our read and our write → 404, and the deleted expense is not re-posted', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    // Interleave: our `existing` read sees a live row; then DELETE (soft-delete +
    // reversal) commits before our transaction's UPDATE runs.
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await del()).status).toBe(200);
      return realTx(fn);
    };

    const { status } = await send({ amountCents: 5200 });
    expect(status).toBe(404);
    expect(expenseRow().amountCents).toBe(4200);
    expect(entriesOf('expense_amend')).toHaveLength(0);
    expect(h.fake.netByAccount()).toEqual({}); // only the original + DELETE's reversal
  });

  it('an edit that commits between our read and our write is built upon, not double-posted', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    // Our `existing` snapshot says amount 4200 / entry je-1; another edit then
    // reposts to 6100 before our transaction runs. In Postgres our UPDATE waits
    // on that edit's row lock, then the helper re-reads the committed pointer.
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await send({ amountCents: 6100 })).status).toBe(200);
      return realTx(fn);
    };

    const { status } = await send({ amountCents: 5200 });
    expect(status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
    expect(entriesOf('expense_amend_reversal')).toHaveLength(2);
    expectEveryEntryBalanced();
  });
});

describe('an entry that was ALREADY reversed (delete → restore, bot orphan) is never reversed again', () => {
  /** Snapshot of everything an edit could write. */
  const snap = () => JSON.parse(JSON.stringify({
    expenses: h.fake.state.expenses, entries: h.fake.state.entries, lines: h.fake.state.lines, vendors: h.fake.state.vendors,
  }));

  async function deleteAndRestore() {
    expect((await del()).status).toBe(200);
    h.fake.restoreExpense(); // Restore clears deletedAt only — it does not re-book
    // Pre-existing restore bug, made visible: the restored expense nets to $0.
    expect(h.fake.netByAccount()).toEqual({});
  }

  it('delete → restore → edit amount: 422 already_reversed, books AND expense row unchanged', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    await deleteAndRestore();
    const before = snap();

    const { status, json } = await send({ amountCents: 4000, vendor: 'Blue Bottle', description: 'x' });

    expect(status).toBe(422);
    expect(json).toMatchObject({ success: false, code: 'already_reversed' });
    expect(json.error).toMatch(/already reversed/i);
    expect(snap()).toEqual(before); // nothing written: no row update, no vendor, no entry
    expect(h.fake.netByAccount()).toEqual({}); // not −$60
  });

  it('delete → restore → flip to personal: 422 already_reversed (would have booked −$100)', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    await deleteAndRestore();
    const before = snap();
    const { status, json } = await send({ isPersonal: true });
    expect(status).toBe(422);
    expect(json.code).toBe('already_reversed');
    expect(snap()).toEqual(before);
  });

  it.each([
    ['category', { categoryId: 'acct-travel' }],
    ['date', { date: '2026-03-10' }],
  ])('delete → restore → %s edit: 422 already_reversed', async (_n, body) => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    await deleteAndRestore();
    const before = snap();
    expect((await send(body)).status).toBe(422);
    expect(snap()).toEqual(before);
  });

  it('delete → restore after an edit chain: the delete reversal of the CURRENT entry is still detected', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    expect((await send({ amountCents: 7000 })).status).toBe(200);
    await deleteAndRestore();
    expect((await send({ amountCents: 4000 })).status).toBe(422);
    expect(h.fake.netByAccount()).toEqual({});
  });

  /**
   * What agentbook-bot-agent expense.update_amount leaves when its replacement
   * hits P2002: a mirror of E under ('expense', expenseId). That reversal can
   * only commit when E itself is NOT keyed ('expense', expenseId) — i.e. E came
   * from the create route (sourceId null) — otherwise G-021 rejects it too.
   */
  function seedBotOrphan(memo: string) {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    h.fake.state.entries.find((e: any) => e.id === entryId).sourceId = null; // create-route shape
    h.fake.state.entries.push({ id: 'je-bot-rev', tenantId: 't1', date: new Date(), memo, sourceType: 'expense', sourceId: 'exp-1', verified: true, createdAt: new Date() });
    for (const l of h.fake.state.lines.filter((x: any) => x.entryId === entryId)) {
      h.fake.state.lines.push({ id: `${l.id}-rev`, tenantId: 't1', entryId: 'je-bot-rev', accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, description: `Reversal: ${l.description}` });
    }
    return entryId;
  }

  it('a bot-style orphaned reversal (REVERSAL: entry committed, replacement failed, pointer still E) refuses the edit', async () => {
    seedBotOrphan('REVERSAL: Expense: Coffee (amount fix)');
    const before = snap();
    const { status, json } = await send({ amountCents: 5200 });
    expect(status).toBe(422);
    expect(json.code).toBe('already_reversed');
    expect(snap()).toEqual(before);
  });

  it('a bot orphan is caught even after its lines no longer mirror E (memo marker)', async () => {
    const entryId = seedBotOrphan('REVERSAL: Expense: Coffee (amount fix)');
    // E's debit moved in place (as reclassifyFromSuspense does) — content no longer mirrors.
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).accountId = 'acct-travel';
    expect((await send({ amountCents: 5200 })).status).toBe(422);
  });

  it('a mirror under ("expense", expenseId) is caught even without the REVERSAL: memo (content)', async () => {
    seedBotOrphan('Expense correction');
    expect((await send({ isPersonal: true })).status).toBe(422);
  });

  it("the confirm route's own ('expense', expenseId) booking, once superseded, does NOT block later edits", async () => {
    // seedBookedExpense keys E0 as ('expense', 'exp-1') — the confirm-route shape.
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    expect((await send({ amountCents: 4000 })).status).toBe(200); // E0 superseded by E1
    expect((await send({ amountCents: 6000 })).status).toBe(200); // E0 is now a candidate, same direction
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 6000, 'acct-cash': -6000 });
  });

  it('positive control: a normal booked expense (never deleted) still edits', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    expect((await send({ amountCents: 4000 })).status).toBe(200);
    expect((await send({ isPersonal: true })).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({});
    expect((await send({ isPersonal: false })).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4000, 'acct-cash': -4000 });
  });

  it('delete → restore → categorize from suspense (debit moved in place) → edit amount: 422, books and P&L unchanged', async () => {
    // Reviewer's reproduction. The content-only guard let this through and booked −$60.
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    await deleteAndRestore();
    const { categorizeExpense } = await import('@/lib/agentbook-categorize-expense');
    const beforeCat = snap();
    const cat = await categorizeExpense('t1', 'exp-1', { categoryId: 'acct-meals', source: 'user' });
    // Re-categorizing a booked expense reposts its entry, so — like the PATCH
    // route — an already-reversed entry is refused and nothing is written. (It
    // is NOT reclassified either: that would book +meals / −suspense.)
    expect(cat).toMatchObject({ ok: false, status: 422, code: 'already_reversed' });
    expect(snap()).toEqual(beforeCat);
    expect(h.fake.netByAccount()).toEqual({});
    const before = snap();

    const { status, json } = await send({ amountCents: 4000 });
    expect(status).toBe(422);
    expect(json.code).toBe('already_reversed');
    expect(snap()).toEqual(before);
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('even if the debit WAS moved in place (data from before this fix), the edit is still refused', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 10000, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    await deleteAndRestore();
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).accountId = 'acct-meals';
    h.fake.state.expenses[0].categoryId = 'acct-meals';
    const before = snap();
    expect((await send({ amountCents: 4000 })).status).toBe(422);
    expect((await send({ isPersonal: true })).status).toBe(422);
    expect(snap()).toEqual(before);
  });

  it('delete → categorize: 404 / no-op, the books are not touched', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN, debitAccountId: 'acct-suspense', categoryId: null });
    expect((await del()).status).toBe(200);
    const before = snap();
    const { categorizeExpense } = await import('@/lib/agentbook-categorize-expense');
    const cat = await categorizeExpense('t1', 'exp-1', { categoryId: 'acct-meals', source: 'user' });
    expect(cat).toMatchObject({ ok: false, status: 404 });
    const { backfillExpenseJournalEntry } = await import('@/lib/agentbook-expense-ledger');
    expect(await backfillExpenseJournalEntry('t1', 'exp-1')).toBeNull();
    expect(snap()).toEqual(before);
  });

  it('delete → restore → date edit on a MULTI-LINE entry: 422 already_reversed (no shape guess, no write)', async () => {
    const { entryId } = h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    h.fake.state.lines.find((l: any) => l.entryId === entryId && l.debitCents > 0).debitCents = 9500;
    h.fake.state.lines.push({ id: 'jl-tax', tenantId: 't1', entryId, accountId: 'acct-tax', debitCents: 500, creditCents: 0 });
    expect((await del()).status).toBe(200);
    h.fake.restoreExpense();
    const before = snap();
    const { status, json } = await send({ date: '2026-03-10' });
    expect(status).toBe(422);
    expect(json.code).toBe('already_reversed');
    expect(snap()).toEqual(before);
  });

  it('the message does not promise a re-book action that does not exist', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    await deleteAndRestore();
    const { json } = await send({ amountCents: 4000 });
    expect(json.error).toMatch(/can't be edited until a bookkeeper re-books it/);
    expect(json.error).not.toMatch(/Re-book it before editing/);
  });

  it('a restored expense can still take edits that do not touch the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    await deleteAndRestore();
    expect((await send({ description: 'Latte', vendor: 'Blue Bottle' })).status).toBe(200);
  });
});

describe('normal chains are never mistaken for "already reversed"', () => {
  it('category A → B → A, personal ↔ business, amount and date: every step 200, books follow', async () => {
    h.fake.seedBookedExpense({ amountCents: 10000, date: JAN });
    const steps: Array<[Record<string, unknown>, Record<string, number>]> = [
      [{ categoryId: 'acct-travel' }, { 'acct-travel': 10000, 'acct-cash': -10000 }],
      [{ categoryId: 'acct-meals' }, { 'acct-meals': 10000, 'acct-cash': -10000 }],
      [{ categoryId: 'acct-travel', amountCents: 4000 }, { 'acct-travel': 4000, 'acct-cash': -4000 }],
      [{ isPersonal: true }, {}],
      [{ isPersonal: false }, { 'acct-travel': 4000, 'acct-cash': -4000 }],
      [{ categoryId: 'acct-meals' }, { 'acct-meals': 4000, 'acct-cash': -4000 }],
      [{ isPersonal: true }, {}],
      [{ isPersonal: false, date: '2026-02-01' }, { 'acct-meals': 4000, 'acct-cash': -4000 }],
      [{ amountCents: 7000 }, { 'acct-meals': 7000, 'acct-cash': -7000 }],
    ];
    for (const [body, books] of steps) {
      const { status, json } = await send(body);
      expect(status, `${JSON.stringify(body)} → ${JSON.stringify(json)}`).toBe(200);
      expect(h.fake.netByAccount()).toEqual(books);
    }
    expectEveryEntryBalanced();
    expect((await del()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({});
  });
});

describe('races (flips)', () => {
  it('two personal → business flips racing: the second waits, sees the first booking, and books nothing', async () => {
    seedUnbooked({ isPersonal: true });
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await send({ isPersonal: false })).status).toBe(200); // the other request commits first
      return realTx(fn);
    };
    const { status } = await send({ isPersonal: false }); // our snapshot still says personal
    expect(status).toBe(200);
    expect(h.fake.state.entries).toHaveLength(1);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('re-sending an "unchanged" amount after a concurrent edit changed it still re-prices the books', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await send({ amountCents: 6100 })).status).toBe(200);
      return realTx(fn);
    };
    // Our snapshot says 4200, so 4200 looks "unchanged" — but it is a change
    // relative to the committed 6100 we overwrite.
    expect((await send({ amountCents: 4200 })).status).toBe(200);
    expect(expenseRow().amountCents).toBe(4200);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('re-sending isPersonal:false after a concurrent flip to personal re-books the expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await send({ isPersonal: true })).status).toBe(200);
      return realTx(fn);
    };
    expect((await send({ isPersonal: false })).status).toBe(200);
    expect(expenseRow().isPersonal).toBe(false);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });

  it('a business → personal flip racing a delete is a 404 and reverses nothing twice', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const realTx = h.fake.db.$transaction;
    h.fake.db.$transaction = async (fn: any) => {
      h.fake.db.$transaction = realTx;
      expect((await del()).status).toBe(200);
      return realTx(fn);
    };
    expect((await send({ isPersonal: true })).status).toBe(404);
    expect(h.fake.state.entries).toHaveLength(2); // original + the DELETE's reversal
    expect(h.fake.netByAccount()).toEqual({});
  });
});

describe('INVARIANT: after any edit sequence, the books equal the expense', () => {
  /** What the ledger must say for the expense as it stands now. */
  function expectBooksMatchExpense() {
    const exp = expenseRow();
    expectEveryEntryBalanced();
    if (exp.isPersonal || exp.status === 'rejected') {
      expect(h.fake.netByAccount()).toEqual({});
      return;
    }
    const debit = exp.categoryId ?? 'acct-suspense';
    expect(h.fake.netByAccount()).toEqual({ [debit]: exp.amountCents, 'acct-cash': -exp.amountCents });
    // ...all of it in the expense's own month
    const from = new Date(Date.UTC(exp.date.getUTCFullYear(), exp.date.getUTCMonth(), 1));
    const to = new Date(Date.UTC(exp.date.getUTCFullYear(), exp.date.getUTCMonth() + 1, 1));
    expect(h.fake.netByAccountInRange(from, to)).toEqual({ [debit]: exp.amountCents, 'acct-cash': -exp.amountCents });
    // ...and the pointer names an entry whose debits ARE the amount
    const lines = linesOf(exp.journalEntryId);
    expect(lines.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(exp.amountCents);
  }

  // Deterministic PRNG so a failure is reproducible from the seed.
  function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const CATS = ['acct-meals', 'acct-travel', null];
  const DATES = ['2026-01-15', '2026-01-31T23:30:00.000Z', '2026-03-10', '2025-12-01', '2026-07-04T08:00:00.000Z'];
  const VENDORS = ['Blue Bottle', '星巴克', ''];
  function randomEdit(r: () => number): Record<string, unknown> {
    const edit: Record<string, unknown> = {};
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      switch (Math.floor(r() * 6)) {
        case 0: edit.amountCents = 1 + Math.floor(r() * 50000); break;
        case 1: edit.date = DATES[Math.floor(r() * DATES.length)]; break;
        case 2: edit.categoryId = CATS[Math.floor(r() * CATS.length)]; break;
        case 3: edit.isPersonal = r() < 0.5; break;
        case 4: edit.vendor = VENDORS[Math.floor(r() * VENDORS.length)]; break;
        default: edit.description = `d${Math.floor(r() * 100)}`;
      }
    }
    return edit;
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('random sequence, seed %i (60 edits, PUT and PATCH)', async (seed) => {
    const r = prng(seed);
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const seen = new Set<string>();
    for (let step = 0; step < 60; step++) {
      const edit = randomEdit(r);
      const { status, json } = await send(edit, r() < 0.5 ? 'PUT' : 'PATCH');
      expect(status, `step ${step} ${JSON.stringify(edit)} → ${JSON.stringify(json)}`).toBe(200);
      expectBooksMatchExpense();
      const exp = expenseRow();
      seen.add(exp.isPersonal ? 'personal' : exp.categoryId ? `business:${exp.categoryId}` : 'business:suspense');
    }
    // The sequence really did walk through every ledger state, not just one.
    expect([...seen].sort()).toEqual(['business:acct-meals', 'business:acct-travel', 'business:suspense', 'personal']);
    // Deleting at the end nets everything to zero.
    expect((await del()).status).toBe(200);
    expect(h.fake.netByAccount()).toEqual({});
  });
});
