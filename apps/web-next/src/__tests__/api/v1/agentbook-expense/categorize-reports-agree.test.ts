// @vitest-environment node
/**
 * After "Change category" on BOOKED expenses, the per-category reports must
 * agree with the expense rows: P&L by category (accrual AND cash basis) and
 * both trial balances by account.
 *
 * The categorize path used to leave a re-categorized expense's debit on its OLD
 * account (only a 6999 suspense debit was ever moved), so after Meals → Fuel the
 * row said Fuel while every one of these reports still said Meals.
 *
 * Same harness as expense-edit-reports-agree.test.ts: the shared mem-db
 * (applies `where`, models relations by embedding) + `hydrate()` re-embedding
 * entry/lines the way Prisma resolves the relations, then the REAL report
 * routes read them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { POST as CATEGORIZE } from '@/app/api/v1/agentbook-expense/expenses/[id]/categorize/route';
import { GET as PNL } from '@/app/api/v1/agentbook-tax/reports/pnl/route';
import { GET as TAX_TRIAL_BALANCE } from '@/app/api/v1/agentbook-tax/reports/trial-balance/route';
import { GET as CORE_TRIAL_BALANCE } from '@/app/api/v1/agentbook-core/trial-balance/route';

const categorize = async (id: string, categoryId: string) =>
  (
    await CATEGORIZE(
      tenantReq(`/api/v1/agentbook-expense/expenses/${id}/categorize`, 't1', { method: 'POST', body: { categoryId, source: 'user' } }),
      { params: Promise.resolve({ id }) },
    )
  ).status;

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

/** What the books SHOULD hold per expense account: every live, booked, business expense at its row's category. */
function expectedByCategory(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of memDb.table('abExpense').rows) {
    if (e.tenantId !== 't1' || e.deletedAt || e.isPersonal || e.status === 'rejected' || !e.journalEntryId) continue;
    const acct = (e.categoryId as string | null) ?? 'acc-susp';
    out[acct] = (out[acct] ?? 0) + (e.amountCents as number);
  }
  return out;
}

const EXPENSE_ACCOUNTS = new Set(['acc-meals', 'acc-fuel', 'acc-susp']);
const toMap = (rows: Array<{ accountId: string; cents: number }>) =>
  Object.fromEntries(rows.filter((r) => EXPENSE_ACCOUNTS.has(r.accountId) && r.cents !== 0).map((r) => [r.accountId, r.cents]));

async function reportsByCategory() {
  hydrate();
  const range = 'startDate=2026-01-01&endDate=2026-12-31';
  const pnl = async (basis: string) =>
    toMap(
      (await json<{ data: { expenses: Array<{ accountId: string; amountCents: number }> } }>(
        await PNL(tenantReq(`/api/v1/agentbook-tax/reports/pnl?${range}&basis=${basis}`, 't1')),
      )).data.expenses.map((l) => ({ accountId: l.accountId, cents: l.amountCents })),
    );
  const taxTb = (await json<{ data: { lines: Array<{ accountId: string; debitCents: number; creditCents: number }> } }>(
    await TAX_TRIAL_BALANCE(tenantReq('/api/v1/agentbook-tax/reports/trial-balance?asOfDate=2026-12-31', 't1')),
  )).data.lines;
  const coreTb = (await json<{ data: { accounts: Array<{ accountId: string; balance: number }> } }>(
    await CORE_TRIAL_BALANCE(tenantReq('/api/v1/agentbook-core/trial-balance', 't1')),
  )).data.accounts;
  return {
    pnlAccrual: await pnl('accrual'),
    pnlCash: await pnl('cash'),
    trialBalance: toMap(taxTb.map((l) => ({ accountId: l.accountId, cents: l.debitCents - l.creditCents }))),
    coreTrialBalance: toMap(coreTb.map((a) => ({ accountId: a.accountId, cents: a.balance }))),
  };
}

const allAgree = (r: Awaited<ReturnType<typeof reportsByCategory>>, expected: Record<string, number>) =>
  expect(r).toEqual({ pnlAccrual: expected, pnlCash: expected, trialBalance: expected, coreTrialBalance: expected });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('per-category reports follow a re-categorized booked expense', () => {
  it('the fixture starts consistent (guards the test itself)', async () => {
    const expected = expectedByCategory();
    expect(expected).toEqual({ 'acc-fuel': 12000, 'acc-meals': 21900, 'acc-susp': 6000 });
    allAgree(await reportsByCategory(), expected);
  });

  it('Meals → Fuel and suspense → Meals: P&L by category and both trial balances equal the rows', async () => {
    expect(await categorize('e2', 'acc-fuel')).toBe(200); // booked Meals 12000 → Fuel
    expect(await categorize('e6', 'acc-meals')).toBe(200); // booked suspense 6000 → Meals
    expect(await categorize('e2', 'acc-fuel')).toBe(200); // retry: no-op

    const expected = expectedByCategory();
    expect(expected).toEqual({ 'acc-fuel': 24000, 'acc-meals': 15900 });
    allAgree(await reportsByCategory(), expected);
  });
});
