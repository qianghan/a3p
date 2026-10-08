// @vitest-environment node
/**
 * After editing booked expenses (amount, date, category, personal flip), every
 * report that reads the ledger must show the EDITED figures — once.
 *
 * Reposting appends a reversing entry. Two readers ignored reversals:
 *   - cash basis (tax estimate + P&L) matched only entries that CREDIT cash;
 *     a reversal DEBITS cash, so it was dropped;
 *   - tax-package / tax-summary / annual-summary / quarterly-comparison
 *     summed expense DEBITS only, so a reversal's credit was dropped.
 * Either way a $40 expense edited to $45 counted $85.
 *
 * Uses the shared mem-db (applies `where`, models relations by EMBEDDING). The
 * ledger helpers write flat rows, so `hydrate()` re-embeds entry/lines the way
 * Prisma would resolve the relations, before the reports read them. mem-db has
 * no $transaction rollback — this file proves report arithmetic, not atomicity.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { PATCH } from '@/app/api/v1/agentbook-expense/expenses/[id]/route';
import { computeTaxEstimate } from '@/lib/agentbook-tax-estimate';
import { GET as PNL } from '@/app/api/v1/agentbook-tax/reports/pnl/route';
import { GET as TAX_PACKAGE } from '@/app/api/v1/agentbook-core/tax-package/route';
import { GET as TAX_SUMMARY } from '@/app/api/v1/agentbook-tax/reports/tax-summary/route';
import { GET as ANNUAL } from '@/app/api/v1/agentbook-tax/reports/annual-summary/route';
import { GET as QUARTERLY } from '@/app/api/v1/agentbook-tax/reports/quarterly-comparison/route';

const patch = async (id: string, body: unknown) =>
  (await PATCH(tenantReq(`/api/v1/agentbook-expense/expenses/${id}`, 't1', { method: 'PATCH', body }), { params: Promise.resolve({ id }) })).status;

/** Re-embed relations the way Prisma resolves them (mem-db models relations by embedding). */
function hydrate() {
  const entries = memDb.table('abJournalEntry').rows;
  const lines = memDb.table('abJournalLine').rows;
  const plain = (l: Row) => ({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents });
  for (const l of lines) {
    const e = entries.find((x) => x.id === l.entryId)!;
    l.entry = { id: e.id, tenantId: e.tenantId, date: e.date, lines: lines.filter((x) => x.entryId === e.id).map(plain) };
  }
  for (const a of memDb.table('abAccount').rows) {
    a.journalLines = lines.filter((l) => l.accountId === a.id).map((l) => ({ debitCents: l.debitCents, creditCents: l.creditCents }));
  }
}

/** What the books SHOULD hold: every live, booked, business, non-rejected expense, once, at its current amount. */
function expectedExpenseCents(from: Date, to: Date): number {
  return memDb
    .table('abExpense')
    .rows.filter(
      (e) =>
        e.tenantId === 't1' && !e.deletedAt && !e.isPersonal && e.status !== 'rejected' && e.journalEntryId &&
        (e.date as Date) >= from && (e.date as Date) <= to,
    )
    .reduce((s, e) => s + (e.amountCents as number), 0);
}

async function reportTotals() {
  hydrate();
  const range = 'startDate=2026-01-01&endDate=2026-12-31';
  const pnl = async (basis: string) =>
    (await json<{ data: { totalExpensesCents: number } }>(await PNL(tenantReq(`/api/v1/agentbook-tax/reports/pnl?${range}&basis=${basis}`, 't1')))).data.totalExpensesCents;
  const quarters = (await json<{ data: Array<{ expensesCents: number }> }>(await QUARTERLY(tenantReq('/api/v1/agentbook-tax/reports/quarterly-comparison?year=2026', 't1')))).data;
  return {
    estimateAccrual: (await computeTaxEstimate('t1', { basis: 'accrual', startDate: '2026-01-01', endDate: '2026-12-31' })).expensesCents,
    estimateCash: (await computeTaxEstimate('t1', { basis: 'cash', startDate: '2026-01-01', endDate: '2026-12-31' })).expensesCents,
    pnlAccrual: await pnl('accrual'),
    pnlCash: await pnl('cash'),
    taxPackage: (await json<{ data: { totalExpensesCents: number } }>(await TAX_PACKAGE(tenantReq('/api/v1/agentbook-core/tax-package?year=2026', 't1')))).data.totalExpensesCents,
    taxSummary: (await json<{ data: { totalCents: number } }>(await TAX_SUMMARY(tenantReq('/api/v1/agentbook-tax/reports/tax-summary?taxYear=2026', 't1')))).data.totalCents,
    annual: (await json<{ data: { expensesCents: number } }>(await ANNUAL(tenantReq('/api/v1/agentbook-tax/reports/annual-summary?year=2026', 't1')))).data.expensesCents,
    quarterly: quarters.reduce((s, q) => s + q.expensesCents, 0),
    quarters: quarters.map((q) => q.expensesCents),
  };
}

const YEAR = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-12-31T23:59:59.999Z')] as const;
const allEqual = (t: Awaited<ReturnType<typeof reportTotals>>, cents: number) => {
  const { quarters: _q, ...totals } = t;
  expect(totals).toEqual({
    estimateAccrual: cents, estimateCash: cents, pnlAccrual: cents, pnlCash: cents,
    taxPackage: cents, taxSummary: cents, annual: cents, quarterly: cents,
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('every ledger report follows an edited expense — once', () => {
  it('the fixture starts consistent (guards the test itself)', async () => {
    allEqual(await reportTotals(), expectedExpenseCents(...YEAR));
    expect(expectedExpenseCents(...YEAR)).toBe(39900);
  });

  it('amount, date, category and personal edits: every report equals the edited expenses', async () => {
    expect(await patch('e1', { amountCents: 5000 })).toBe(200); // fuel 4000 → 5000
    expect(await patch('e2', { isPersonal: true })).toBe(200); // meals 12000 off the books
    expect(await patch('e6', { categoryId: 'acc-meals' })).toBe(200); // suspense → meals
    expect(await patch('e4', { date: '2026-02-10' })).toBe(200); // May → Feb (Q2 → Q1)
    expect(await patch('e1', { amountCents: 4500, date: '2026-04-15' })).toBe(200); // second link in e1's chain

    const expected = expectedExpenseCents(...YEAR);
    expect(expected).toBe(4500 + 8000 + 6000 + 9900);
    const totals = await reportTotals();
    allEqual(totals, expected);
    // Q1 holds the moved e4; Q2 the rest; nothing left behind in Q2 for e4.
    expect(totals.quarters).toEqual([8000, 4500 + 6000 + 9900, 0, 0]);
  });
});
