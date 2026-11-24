/**
 * PR 2c — opt-in restatement of legacy gross (untyped) expenses (spec §5.1).
 *
 * Fake ledger (stateful, applies where clauses, enforces G-021). Every
 * assertion is a computed figure: P&L expense, 2100, cash-basis expense,
 * entry keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ fake: null as any }));
vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import {
  previewTaxRestatement,
  applyTaxRestatement,
  restatementYearBounds,
} from '../tax-restatement';
import { repostExpenseJournalEntry, reverseExpenseJournalEntry } from '../agentbook-expense-ledger';

const EXPENSE_ACCOUNTS = new Set(['acct-meals', 'acct-travel', 'acct-suspense']);
const pnlExpense = () =>
  Object.entries(h.fake.netByAccount() as Record<string, number>)
    .filter(([a]) => EXPENSE_ACCOUNTS.has(a))
    .reduce((s, [, v]) => s + v, 0);
const net = (acct: string) => (h.fake.netByAccount() as Record<string, number>)[acct] ?? 0;
/** Cash basis (lib/agentbook-tax-estimate.ts): expense debits in entries that also touch cash. */
const cashBasisExpense = () => {
  const cashEntries = new Set(h.fake.state.lines.filter((l: any) => l.accountId === 'acct-cash').map((l: any) => l.entryId));
  return h.fake.state.lines
    .filter((l: any) => cashEntries.has(l.entryId) && EXPENSE_ACCOUNTS.has(l.accountId))
    .reduce((s: number, l: any) => s + l.debitCents - l.creditCents, 0);
};
const balanced = () => {
  for (const e of h.fake.state.entries) {
    const ls = h.fake.state.lines.filter((l: any) => l.entryId === e.id);
    expect(ls.reduce((s: number, l: any) => s + l.debitCents - l.creditCents, 0), `${e.sourceType} balanced`).toBe(0);
  }
};

const AU = { userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true };
const CA_ON = { userId: 't1', jurisdiction: 'ca', region: 'ON', gstRegistered: true };

/** A legacy AU row: $110.00 gross with $10.00 GST, booked DR meals | CR cash at gross, no taxCode. */
function seedLegacy(id: string, date: Date, amountCents = 11000, taxAmountCents: number | null = 1000, extra: Record<string, unknown> = {}) {
  h.fake.seedBookedExpense({ id, amountCents, date, debitAccountId: 'acct-meals', ...extra });
  Object.assign(h.fake.state.expenses.find((e: any) => e.id === id), { taxCode: null, recoverableTaxCents: 0, taxAmountCents });
}

beforeEach(() => {
  h.fake = createFakeLedgerDb();
  // Meals isMealsAccount by name; give the generic account a neutral name so AU/CA meals rules are explicit per test.
  for (const a of h.fake.state.accounts) a.name = a.id === 'acct-meals' ? 'Office supplies' : a.id;
});

describe('tax year bounds', () => {
  it('AU income year ends 30 June; CA is the calendar year', () => {
    const au = restatementYearBounds('au', 2026);
    expect([au.from.toISOString().slice(0, 10), au.toExclusive.toISOString().slice(0, 10)]).toEqual(['2025-07-01', '2026-07-01']);
    const ca = restatementYearBounds('ca', 2026);
    expect([ca.from.toISOString().slice(0, 10), ca.toExclusive.toISOString().slice(0, 10)]).toEqual(['2026-01-01', '2027-01-01']);
  });
});

describe('preview', () => {
  it('AU registrant: P&L delta, counts and per-row recoverable tax; writes nothing', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    seedLegacy('e2', new Date('2026-04-02T12:00:00Z'), 5500, 500);
    seedLegacy('e3', new Date('2026-04-03T12:00:00Z'), 3000, null); // no tax amount: never invented
    seedLegacy('e4', new Date('2025-06-30T12:00:00Z')); // FY2025: out of range
    h.fake.seedBookedExpense({ id: 'e5', amountCents: 2200, date: new Date('2026-02-01T12:00:00Z') });
    Object.assign(h.fake.state.expenses.find((e: any) => e.id === 'e5'), { taxCode: 'GST', recoverableTaxCents: 200, taxAmountCents: 200 });
    const entriesBefore = h.fake.state.entries.length;

    const p = await previewTaxRestatement('t1', 2026);
    expect(p.applicable).toBe(true);
    expect(p.eligible.map((r) => [r.expenseId, r.taxCode, r.recoverableTaxCents])).toEqual([['e1', 'GST', 1000], ['e2', 'GST', 500]]);
    expect(p.counts).toEqual({ eligible: 2, skippedClosed: 0, skippedOther: 0, alreadyTyped: 1, noTaxAmount: 1 });
    expect(p.recoverableTaxCents).toBe(1500);
    expect(p.expenseDeltaCents).toBe(-1500);
    expect(p.netProfitDeltaCents).toBe(1500);
    expect([p.from, p.to]).toEqual(['2025-07-01', '2026-06-30']);
    expect(h.fake.state.entries.length).toBe(entriesBefore);
  });

  it('CA (ON HST): meals recover half; the vendor default code wins over the province default', async () => {
    h.fake.state.tenantConfigs.push(CA_ON);
    h.fake.state.accounts.find((a: any) => a.id === 'acct-travel').name = 'Meals & Entertainment';
    seedLegacy('m1', new Date('2026-05-05T12:00:00Z'), 11300, 1300, { debitAccountId: 'acct-travel' });
    seedLegacy('o1', new Date('2026-05-06T12:00:00Z'), 11300, 1300);
    h.fake.state.vendors.push({ id: 'v-zero', tenantId: 't1', defaultTaxCode: 'ZERO' });
    seedLegacy('z1', new Date('2026-05-07T12:00:00Z'), 11300, 1300);
    h.fake.state.expenses.find((e: any) => e.id === 'z1').vendorId = 'v-zero';

    const p = await previewTaxRestatement('t1', 2026);
    expect(p.eligible.map((r) => [r.expenseId, r.taxCode, r.recoverableTaxCents])).toEqual([['m1', 'HST', 650], ['o1', 'HST', 1300]]);
    // ZERO says no tax, the row says $13 — disagreement is never reinterpreted.
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['z1', 'tax_mismatch']]);
    expect(p.recoverableTaxCents).toBe(1950);
  });

  it('a stored tax more than 2¢ off the engine is skipped, not reinterpreted', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('x', new Date('2026-03-10T12:00:00Z'), 11000, 1200);
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.eligible).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(['tax_mismatch']);
  });

  it.each([
    ['US tenant', { userId: 't1', jurisdiction: 'us', gstRegistered: true }, 'unsupported_jurisdiction'],
    ['AU non-registrant', { ...AU, gstRegistered: false }, 'not_registered'],
    ['AU registration unknown', { ...AU, gstRegistered: null }, 'not_registered'],
    ['CA non-registrant', { ...CA_ON, gstRegistered: false }, 'not_registered'],
  ])('%s: nothing to restate', async (_n, cfg, reason) => {
    h.fake.state.tenantConfigs.push(cfg);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'), 11300, 1300);
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.applicable).toBe(false);
    expect(p.notApplicableReason).toBe(reason);
    expect(p.counts.eligible).toBe(0);
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated).toEqual([]);
    expect(h.fake.state.entries.length).toBe(1);
  });
});

describe('apply', () => {
  it('= amend-reversal + 3-line repost under expense_amend* keys; P&L, 2100 and cash basis move by the recoverable tax', async () => {
    h.fake.state.tenantConfigs.push(AU);
    const date = new Date('2026-03-10T12:00:00Z');
    seedLegacy('e1', date);
    const original = h.fake.state.expenses[0].journalEntryId;
    expect([pnlExpense(), net('acct-gst'), cashBasisExpense()]).toEqual([11000, 0, 11000]);

    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated.map((x) => x.expenseId)).toEqual(['e1']);
    balanced();
    expect([pnlExpense(), net('acct-gst'), net('acct-cash'), cashBasisExpense()]).toEqual([10000, 1000, -11000, 10000]);

    const keys = h.fake.state.entries.map((e: any) => [e.sourceType, e.sourceId]);
    expect(keys).toEqual([['expense', 'e1'], ['expense_amend_reversal', original], ['expense_amend', original]]);
    for (const e of h.fake.state.entries) expect(e.date.getTime()).toBe(date.getTime());
    const replacement = h.fake.state.entries[2];
    const lines = h.fake.state.lines.filter((l: any) => l.entryId === replacement.id).map((l: any) => [l.accountId, l.debitCents, l.creditCents]);
    expect(lines).toEqual([['acct-meals', 10000, 0], ['acct-gst', 1000, 0], ['acct-cash', 0, 11000]]);

    const row = h.fake.state.expenses[0];
    expect([row.taxCode, row.recoverableTaxCents, row.taxAmountCents, row.amountCents, row.journalEntryId]).toEqual(['GST', 1000, 1000, 11000, replacement.id]);
  });

  it('second run is a no-op', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    await applyTaxRestatement('t1', 2026);
    const entries = h.fake.state.entries.length;
    const again = await applyTaxRestatement('t1', 2026);
    expect(again.restated).toEqual([]);
    expect(again.counts.alreadyTyped).toBe(1);
    expect(h.fake.state.entries.length).toBe(entries);
    expect(pnlExpense()).toBe(10000);
    expect((await previewTaxRestatement('t1', 2026)).counts.eligible).toBe(0);
  });

  it('two concurrent applies restate each row once', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    const [a, b] = await Promise.all([applyTaxRestatement('t1', 2026), applyTaxRestatement('t1', 2026)]);
    expect(a.restated.length + b.restated.length).toBe(1);
    expect([a.skipped.length + b.skipped.length, a.counts.alreadyTyped + b.counts.alreadyTyped]).toEqual([0, 1]);
    expect(h.fake.state.entries.length).toBe(3);
    balanced();
    expect([pnlExpense(), net('acct-gst')]).toEqual([10000, 1000]);
  });

  it('rows in a closed period are skipped and listed with the reason; the open ones restate', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('closed', new Date('2025-09-15T12:00:00Z'));
    seedLegacy('open', new Date('2026-03-10T12:00:00Z'));
    h.fake.state.periods.push({ tenantId: 't1', year: 2025, month: 9, status: 'closed' });

    const p = await previewTaxRestatement('t1', 2026);
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['closed', 'period_closed']]);
    expect(p.counts.skippedClosed).toBe(1);

    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated.map((x) => x.expenseId)).toEqual(['open']);
    expect(r.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['closed', 'period_closed']]);
    expect(h.fake.state.expenses.find((e: any) => e.id === 'closed').taxCode).toBeNull();
    expect(pnlExpense()).toBe(11000 + 10000);
    balanced();
  });

  it('a later delete of a restated row takes everything off the books (incl. 2100)', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    await applyTaxRestatement('t1', 2026);
    expect((await reverseExpenseJournalEntry('t1', 'e1')).reversed).toBe(true);
    balanced();
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('a later amount amend of a restated row reprices the 3-line shape', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    await applyTaxRestatement('t1', 2026);
    // What the expense PATCH route does on an amount edit: recompute recoverable tax ($220 incl GST → $20).
    Object.assign(h.fake.state.expenses[0], { amountCents: 22000, taxAmountCents: 2000, recoverableTaxCents: 2000 });
    expect((await repostExpenseJournalEntry('t1', 'e1', h.fake.db)).reposted).toBe(true);
    balanced();
    expect([pnlExpense(), net('acct-gst'), net('acct-cash'), cashBasisExpense()]).toEqual([20000, 2000, -22000, 20000]);
  });

  it('is tenant-scoped: another tenant\'s legacy rows are untouched', async () => {
    h.fake.state.tenantConfigs.push(AU, { ...AU, userId: 't2' });
    h.fake.state.accounts.push({ id: 'acct-t2-cash', tenantId: 't2', code: '1000', accountType: 'asset', isActive: true });
    seedLegacy('mine', new Date('2026-03-10T12:00:00Z'));
    seedLegacy('theirs', new Date('2026-03-10T12:00:00Z'), 11000, 1000, { tenantId: 't2', debitAccountId: 'acct-t2-meals' });
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated.map((x) => x.expenseId)).toEqual(['mine']);
    const theirs = h.fake.state.expenses.find((e: any) => e.id === 'theirs');
    expect(theirs.taxCode).toBeNull();
    expect(h.fake.state.entries.filter((e: any) => e.tenantId === 't2').length).toBe(1);
  });

  it('a deleted-then-restored row (already reversed) is skipped, never re-reversed', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('e1', new Date('2026-03-10T12:00:00Z'));
    await reverseExpenseJournalEntry('t1', 'e1');
    h.fake.restoreExpense('e1');
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['already_reversed']);
    expect(h.fake.netByAccount()).toEqual({});
  });

  it('a split legacy entry is skipped as unsupported_shape', async () => {
    h.fake.state.tenantConfigs.push(AU);
    h.fake.seedEntryExpense({
      id: 's1', date: new Date('2026-03-10T12:00:00Z'), amountCents: 11000,
      lines: [
        { accountId: 'acct-meals', debitCents: 5500, creditCents: 0 },
        { accountId: 'acct-travel', debitCents: 5500, creditCents: 0 },
        { accountId: 'acct-cash', debitCents: 0, creditCents: 11000 },
      ],
      expense: { taxCode: null, taxAmountCents: 1000, recoverableTaxCents: 0 },
    });
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.skipped.map((s) => s.reason)).toEqual(['unsupported_shape']);
    expect(h.fake.state.entries.length).toBe(1);
  });
});

describe('review fix round 1', () => {
  const three = () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('r1', new Date('2026-03-01T12:00:00Z'));
    seedLegacy('r2', new Date('2026-03-02T12:00:00Z'));
    seedLegacy('r3', new Date('2026-03-03T12:00:00Z'));
  };

  it('I-2: a generic failure on row 2 is reported per row; the batch still returns what it committed; a re-run picks up only the failed row', async () => {
    three();
    h.fake.state.injectTxErrors.push('', 'ETIMEDOUT');
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated.map((x) => x.expenseId)).toEqual(['r1', 'r3']);
    expect(r.failed.map((x) => [x.expenseId, x.reason])).toEqual([['r2', 'error']]);
    expect(r.remaining).toBe(0);
    expect(r.recoverableTaxCents).toBe(2000); // only what was written
    expect(net('acct-gst')).toBe(2000);
    balanced();
    const again = await applyTaxRestatement('t1', 2026);
    expect(again.restated.map((x) => x.expenseId)).toEqual(['r2']);
    expect(net('acct-gst')).toBe(3000);
  });

  it('I-2: the batch is bounded and returns `remaining`; the next call continues where it stopped', async () => {
    three();
    const first = await applyTaxRestatement('t1', 2026, undefined, { limit: 2 });
    expect([first.restated.map((x) => x.expenseId), first.remaining]).toEqual([['r1', 'r2'], 1]);
    const second = await applyTaxRestatement('t1', 2026, undefined, { limit: 2 });
    expect([second.restated.map((x) => x.expenseId), second.remaining, second.counts.alreadyTyped]).toEqual([['r3'], 0, 2]);
  });

  it('I-2: the time budget stops the batch early with `remaining`', async () => {
    three();
    let t = 0;
    const r = await applyTaxRestatement('t1', 2026, undefined, { timeBudgetMs: 10, now: () => (t += 6) });
    expect(r.restated.length).toBe(1);
    expect(r.remaining).toBe(2);
  });

  it('M-1: a row whose category drifted from the booked account is not restated (preview and apply agree)', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('d', new Date('2026-03-01T12:00:00Z'));
    h.fake.state.expenses[0].categoryId = 'acct-travel'; // booked to acct-meals
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['d', 'unsupported_shape']]);
    const r = await applyTaxRestatement('t1', 2026);
    expect(r.restated).toEqual([]);
    expect(h.fake.state.entries.length).toBe(1);
  });

  it('M-2: the original entry dated in a closed month makes the row period_closed in preview, not only at apply', async () => {
    h.fake.state.tenantConfigs.push(AU);
    seedLegacy('m', new Date('2026-03-01T12:00:00Z'));
    h.fake.state.entries[0].date = new Date('2026-02-10T12:00:00Z'); // a date edit that never reposted
    h.fake.state.periods.push({ tenantId: 't1', year: 2026, month: 2, status: 'closed' });
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['m', 'period_closed']]);
    expect(p.counts.eligible).toBe(0);
  });

  it('M-4: a row in another currency than the tenant\'s is skipped as currency_mismatch', async () => {
    h.fake.state.tenantConfigs.push({ ...AU, currency: 'AUD' });
    seedLegacy('nzd', new Date('2026-03-01T12:00:00Z'));
    seedLegacy('aud', new Date('2026-03-02T12:00:00Z'));
    h.fake.state.expenses[0].currency = 'NZD';
    h.fake.state.expenses[1].currency = 'AUD';
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.eligible.map((r) => r.expenseId)).toEqual(['aud']);
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['nzd', 'currency_mismatch']]);
  });
});

describe('review fix round 2', () => {
  const CA_AB = { userId: 't1', jurisdiction: 'ca', region: 'AB', gstRegistered: true, currency: 'CAD' };

  it('N-1: a USD-stored (create-path default) CA row with 5% GST is eligible; a real US receipt (8% sales tax) is tax_mismatch', async () => {
    h.fake.state.tenantConfigs.push(CA_AB);
    seedLegacy('gst', new Date('2026-03-01T12:00:00Z'), 10500, 500);
    seedLegacy('us', new Date('2026-03-02T12:00:00Z'), 10800, 800);
    seedLegacy('eur', new Date('2026-03-03T12:00:00Z'), 10500, 500);
    for (const e of h.fake.state.expenses) e.currency = e.id === 'eur' ? 'EUR' : 'USD';
    const p = await previewTaxRestatement('t1', 2026);
    expect(p.eligible.map((r) => [r.expenseId, r.taxCode, r.recoverableTaxCents])).toEqual([['gst', 'GST', 500]]);
    expect(p.skipped.map((s) => [s.expenseId, s.reason])).toEqual([['us', 'tax_mismatch'], ['eur', 'currency_mismatch']]);
  });

  it('N-2: 105 persistently failing rows do not starve the good rows after them (cursor)', async () => {
    h.fake.state.tenantConfigs.push(AU);
    const d = new Date('2026-03-01T12:00:00Z');
    for (let i = 0; i < 105; i++) seedLegacy(`a${String(i).padStart(3, '0')}`, d);
    for (const id of ['b1', 'b2', 'b3']) seedLegacy(id, d);
    const fail = () => { h.fake.state.injectTxErrors.length = 0; for (let i = 0; i < 105; i++) h.fake.state.injectTxErrors.push('ETIMEDOUT'); };
    fail();
    const first = await applyTaxRestatement('t1', 2026);
    expect([first.restated.length, first.failed.length, first.remaining]).toEqual([0, 100, 8]);
    expect(first.cursor).toBeTruthy();
    const second = await applyTaxRestatement('t1', 2026, undefined, { cursor: first.cursor });
    expect(second.failed.length).toBe(5);
    expect(second.restated.map((x) => x.expenseId)).toEqual(['b1', 'b2', 'b3']);
    expect([second.remaining, second.cursor ?? null]).toEqual([0, null]);
  });
});
