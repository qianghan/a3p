import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `buildLedgerHeadline` exists because the grounding pack — built on EVERY
 * consultative turn — was reading its four headline figures from
 * `buildFinancialContext`, which runs ~9 queries, several of them unbounded
 * (every non-personal expense ever, with a vendor join; every journal line on
 * the cash account; all clients; all recurring rules) and filters by date in
 * JS afterwards. The pack's contract is "cheap, bounded, safe on any turn".
 *
 * So the figures now come from aggregates that push the filter into the
 * database. The risk that swap creates is DRIFT: two derivations of "revenue"
 * that disagree is exactly how the advisor ends up quoting a number the
 * briefing contradicts one screen away. These tests pin the window semantics
 * of each figure.
 *
 * The db mock APPLIES its `where` clause — a fixed array that ignores `where`
 * cannot fail on a bug whose cause IS the filter, which is the whole class of
 * bug a bounded-query rewrite can introduce.
 */

const fixtures = vi.hoisted(() => {
  /**
   * A Prisma-shaped `where` evaluated against a fixture row. Covers the shapes
   * buildLedgerHeadline actually passes: scalar equality (`tenantId`,
   * `isPersonal: false`, `deletedAt: null`, `accountType`, `code`), `{ in }`,
   * `{ gte: Date }`, and the nested relation filter `{ entry: { tenantId, date } }`.
   */
  function matchesWhere(row: any, where: any): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      const val = row?.[key];
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as any;
        if ('in' in c) {
          if (!c.in.includes(val)) return false;
          continue;
        }
        if ('gte' in c) {
          if (val == null) return false;
          if (new Date(val).getTime() < new Date(c.gte).getTime()) return false;
          continue;
        }
        if (!matchesWhere(val ?? {}, c)) return false;
        continue;
      }
      if (val !== cond) return false;
    }
    return true;
  }

  /**
   * A model mock whose reads honour their `where`. `aggregate` returns a null
   * `_sum` field when nothing matches, as Prisma does — so the caller's
   * null-coalescing is exercised rather than assumed.
   */
  function model(rows: any[] = []) {
    return {
      findMany: async (a: any = {}) => rows.filter((r) => matchesWhere(r, a?.where)),
      findFirst: async (a: any = {}) => rows.find((r) => matchesWhere(r, a?.where)) ?? null,
      aggregate: async (a: any = {}) => {
        const matched = rows.filter((r) => matchesWhere(r, a?.where));
        const _sum: Record<string, number | null> = {};
        for (const field of Object.keys(a?._sum ?? {})) {
          _sum[field] = matched.length
            ? matched.reduce((s, r) => s + (r[field] ?? 0), 0)
            : null;
        }
        return { _sum };
      },
    };
  }

  // Frozen clock: every fixture date below is stated relative to it, so the
  // "this year" / "trailing 90 days" boundaries do not move with the calendar.
  const NOW = new Date('2026-06-15T12:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(NOW.getTime() - days * day);
  const LAST_YEAR = new Date('2025-03-04T00:00:00.000Z');

  const accounts = [
    { id: 'acc-rev', tenantId: 't1', accountType: 'revenue', code: '4000' },
    { id: 'acc-cash', tenantId: 't1', accountType: 'asset', code: '1000' },
    // Another tenant's revenue account — must never reach t1's totals.
    { id: 'acc-rev-t2', tenantId: 't2', accountType: 'revenue', code: '4000' },
  ];

  const journalLines = [
    // Revenue, this year.
    { accountId: 'acc-rev', debitCents: 0, creditCents: 500_000, entry: { tenantId: 't1', date: ago(30) } },
    // Revenue, LAST year — the figure is labelled by its window, so this is out.
    { accountId: 'acc-rev', debitCents: 0, creditCents: 900_000, entry: { tenantId: 't1', date: LAST_YEAR } },
    // Cash: a deposit from last year and a payment from this one. Cash on hand
    // is a balance, not a period total — both count.
    { accountId: 'acc-cash', debitCents: 100_000, creditCents: 0, entry: { tenantId: 't1', date: LAST_YEAR } },
    { accountId: 'acc-cash', debitCents: 0, creditCents: 25_000, entry: { tenantId: 't1', date: ago(5) } },
    // Another tenant's revenue.
    { accountId: 'acc-rev-t2', debitCents: 0, creditCents: 777_000, entry: { tenantId: 't2', date: ago(30) } },
  ];

  const expenses = [
    // In the year AND in the trailing-90-day burn window.
    { tenantId: 't1', amountCents: 30_000, isPersonal: false, deletedAt: null, date: ago(10) },
    // In the year, OUTSIDE the burn window — the discriminator between the two.
    { tenantId: 't1', amountCents: 60_000, isPersonal: false, deletedAt: null, date: ago(120) },
    // Last year: out of both.
    { tenantId: 't1', amountCents: 80_000, isPersonal: false, deletedAt: null, date: LAST_YEAR },
    // Each excluded by one clause of the `where`.
    { tenantId: 't1', amountCents: 11_111, isPersonal: true, deletedAt: null, date: ago(10) },
    { tenantId: 't1', amountCents: 22_222, isPersonal: false, deletedAt: ago(1), date: ago(10) },
    { tenantId: 't2', amountCents: 99_999, isPersonal: false, deletedAt: null, date: ago(10) },
  ];

  const tenantConfigs = [{ userId: 't1', currency: 'CAD' }];

  return { model, accounts, journalLines, expenses, tenantConfigs, NOW };
});

const abTenantConfigFindFirst = vi.fn(fixtures.model(fixtures.tenantConfigs).findFirst);

vi.mock('../db/client.js', () => ({
  db: {
    abAccount: fixtures.model(fixtures.accounts),
    abJournalLine: fixtures.model(fixtures.journalLines),
    abExpense: fixtures.model(fixtures.expenses),
    abTenantConfig: {
      ...fixtures.model(fixtures.tenantConfigs),
      findFirst: (...a: any[]) => abTenantConfigFindFirst(...(a as [any])),
    },
    // Reached only by unrelated module-level wiring in server.ts.
    abConversation: { create: vi.fn(async () => ({})) },
    abSkillRun: { create: vi.fn(async () => ({})) },
    abLLMProviderConfig: { findFirst: vi.fn(async () => null) },
    abClient: fixtures.model([]),
    abInvoice: fixtures.model([]),
    abTaxEstimate: fixtures.model([]),
    abRecurringRule: fixtures.model([]),
  },
}));

import { buildLedgerHeadline } from '../server';

const YEAR_START = new Date(2026, 0, 1);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(fixtures.NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildLedgerHeadline', () => {
  it('counts revenue credits posted on or after `since`, and excludes earlier ones', async () => {
    // The label on this figure names a window. A revenue line from last year
    // inflating "revenue since 1 January" is a wrong number under a confident
    // label — the shape of defect the grounding pack exists to prevent.
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(h.revenueCents).toBe(500_000);
  });

  it('counts business expenses on or after `since`, and excludes earlier ones', async () => {
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(h.expenseCents).toBe(30_000 + 60_000);
  });

  it('excludes personal, deleted and other tenants’ expenses', async () => {
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    // 11_111 (personal), 22_222 (deleted) and 99_999 (tenant 2) are all absent.
    expect(h.expenseCents).toBe(90_000);
  });

  it('nets revenue against expenses over the same window', async () => {
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(h.netIncomeCents).toBe(500_000 - 90_000);
  });

  it('reports cash as the all-time balance of account 1000, debits less credits', async () => {
    // Cash on hand is a balance, not a period total: a deposit banked last
    // December is still in the account. Clipping it at `since` would report a
    // business as broke every January.
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(h.cashBalanceCents).toBe(100_000 - 25_000);
  });

  it('computes burn from the trailing 90 days only, not from `since`', async () => {
    // Burn is a rate. The 60_000 spent 120 days ago is inside the year and
    // outside the rate; only the 30_000 counts, over three months.
    const h = await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(h.monthlyBurnCents).toBe(Math.round(30_000 / 3));
  });

  it('returns zeroes, not NaN, for a tenant with no ledger at all', async () => {
    const h = await buildLedgerHeadline('t-empty', YEAR_START, { currency: 'USD' });
    expect(h).toMatchObject({
      revenueCents: 0, expenseCents: 0, netIncomeCents: 0,
      cashBalanceCents: 0, monthlyBurnCents: 0, currency: 'USD',
    });
  });

  it('does not re-read the tenant config when the caller already has the currency', async () => {
    // The grounding pack loads abTenantConfig for the profile fact one line
    // earlier; reading it twice per turn is the cost this helper exists to cut.
    await buildLedgerHeadline('t1', YEAR_START, { currency: 'CAD' });
    expect(abTenantConfigFindFirst).not.toHaveBeenCalled();
  });

  it('falls back to the tenant config currency when the caller passes none', async () => {
    const h = await buildLedgerHeadline('t1', YEAR_START);
    expect(h.currency).toBe('CAD');
  });
});
