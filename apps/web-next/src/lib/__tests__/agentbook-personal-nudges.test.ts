/**
 * Task 3a — checkPersonalFinanceNudges() threshold/dedup logic.
 *
 * Mocks @naap/database's prisma client. AbPersonalTransaction.findMany is
 * called with three distinct where-shapes by the module under test, so the
 * mock routes by shape rather than call order:
 *   - { date, amountCents } -> this month's outflow txns (budget check)
 *   - { date }              -> this month's all txns (savings-rate check)
 *   - { tenantId only }     -> full history (net-worth trend reconstruction)
 *
 * AbPersonalNudgeLog.findUnique/create are backed by a real in-memory Set so
 * dedup behaves like the real unique-constraint semantics across repeated
 * calls within a test, without needing to hand-author "already fired" rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockBudgetFindMany = vi.fn();
const mockAccountFindMany = vi.fn();
const mockTransactionFindMany = vi.fn();
const mockNudgeLogFindFirst = vi.fn();
const mockNudgeLogCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalBudget: { findMany: (...args: unknown[]) => mockBudgetFindMany(...args) },
    abPersonalAccount: { findMany: (...args: unknown[]) => mockAccountFindMany(...args) },
    abPersonalTransaction: { findMany: (...args: unknown[]) => mockTransactionFindMany(...args) },
    abPersonalNudgeLog: {
      findFirst: (...args: unknown[]) => mockNudgeLogFindFirst(...args),
      create: (...args: unknown[]) => mockNudgeLogCreate(...args),
    },
  },
}));

import { checkPersonalFinanceNudges } from '../agentbook-personal-nudges';

const TENANT = 'tenant-1';
const NOW_JULY = new Date(2026, 6, 15); // July 15, 2026
const NOW_AUGUST = new Date(2026, 7, 15); // August 15, 2026

let existingLogKeys: Set<string>;
let budgets: Array<{ category: string; monthlyLimitCents: number }>;
let budgetTxns: Array<{ category: string; amountCents: number }>; // where: date + amountCents<0
let savingsTxns: Array<{ amountCents: number }>; // where: date only
let netWorthAccounts: Array<Record<string, unknown>>;
let netWorthTxns: Array<Record<string, unknown>>; // where: tenantId only (full history)

function logKey(k: { tenantId: string; nudgeType: string; periodKey: string; category: string | null }): string {
  return `${k.tenantId}|${k.nudgeType}|${k.periodKey}|${k.category}`;
}

function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acc-1',
    tenantId: TENANT,
    name: 'Checking',
    type: 'checking',
    balanceCents: 0,
    currency: 'USD',
    isAsset: true,
    plaidAccountId: null,
    archived: false,
    createdAt: new Date(2020, 0, 1),
    updatedAt: new Date(2020, 0, 1),
    ...overrides,
  };
}

function makeTxn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'txn-1',
    tenantId: TENANT,
    accountId: 'acc-1',
    description: 'test',
    amountCents: 0,
    date: new Date(2020, 0, 1),
    category: 'uncategorized',
    businessFlag: false,
    notes: null,
    createdAt: new Date(2020, 0, 1),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_JULY);

  existingLogKeys = new Set();
  budgets = [];
  budgetTxns = [];
  savingsTxns = [];
  netWorthAccounts = [];
  netWorthTxns = [];

  mockBudgetFindMany.mockReset().mockImplementation(async () => budgets);
  mockAccountFindMany.mockReset().mockImplementation(async () => netWorthAccounts);
  mockTransactionFindMany.mockReset().mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.amountCents) return budgetTxns;
    if (where.date) return savingsTxns;
    return netWorthTxns;
  });
  mockNudgeLogFindFirst.mockReset().mockImplementation(async (args: any) => {
    const k = args.where;
    return existingLogKeys.has(logKey(k)) ? { id: 'log-existing', ...k, createdAt: new Date() } : null;
  });
  mockNudgeLogCreate.mockReset().mockImplementation(async (args: any) => {
    existingLogKeys.add(logKey(args.data));
    return { id: 'log-new', ...args.data, createdAt: new Date() };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkPersonalFinanceNudges — budget threshold', () => {
  it('crosses 80% once -> fires budget_alert_80 once, log row created', async () => {
    budgets = [{ category: 'groceries', monthlyLimitCents: 50_000 }];
    budgetTxns = [{ category: 'groceries', amountCents: -40_000 }]; // 40000/50000 = 80%

    const results = await checkPersonalFinanceNudges(TENANT);

    const budgetResults = results.filter((r) => r.nudgeType.startsWith('budget_alert'));
    expect(budgetResults).toHaveLength(1);
    expect(budgetResults[0]).toMatchObject({
      nudgeType: 'budget_alert_80',
      category: 'groceries',
      periodKey: '2026-07',
      alreadyFired: false,
    });
    expect(mockNudgeLogCreate).toHaveBeenCalledTimes(1);
    expect(mockNudgeLogCreate).toHaveBeenCalledWith({
      data: { tenantId: TENANT, nudgeType: 'budget_alert_80', periodKey: '2026-07', category: 'groceries' },
    });
  });

  it('same tenant/category/month checked again after already firing -> does NOT re-fire', async () => {
    budgets = [{ category: 'groceries', monthlyLimitCents: 50_000 }];
    budgetTxns = [{ category: 'groceries', amountCents: -40_000 }]; // still 80%, not 100%

    const first = await checkPersonalFinanceNudges(TENANT);
    expect(first.filter((r) => r.nudgeType.startsWith('budget_alert'))).toHaveLength(1);

    const second = await checkPersonalFinanceNudges(TENANT);
    expect(second.filter((r) => r.nudgeType.startsWith('budget_alert'))).toHaveLength(0);
    expect(mockNudgeLogCreate).toHaveBeenCalledTimes(1); // no duplicate insert attempted
  });

  it('budget later crosses 100% in the SAME month -> fires budget_alert_100 in addition (independent of the 80 dedup)', async () => {
    budgets = [{ category: 'groceries', monthlyLimitCents: 50_000 }];
    budgetTxns = [{ category: 'groceries', amountCents: -40_000 }]; // 80%

    const first = await checkPersonalFinanceNudges(TENANT);
    expect(first.map((r) => r.nudgeType)).toContain('budget_alert_80');
    expect(first.map((r) => r.nudgeType)).not.toContain('budget_alert_100');

    // More spending happens later in the same month, crossing 100%.
    budgetTxns = [{ category: 'groceries', amountCents: -50_000 }];
    const second = await checkPersonalFinanceNudges(TENANT);
    const secondBudget = second.filter((r) => r.nudgeType.startsWith('budget_alert'));
    expect(secondBudget).toHaveLength(1);
    expect(secondBudget[0]).toMatchObject({ nudgeType: 'budget_alert_100', category: 'groceries', periodKey: '2026-07' });

    // Both 80 and 100 log rows now exist independently for this tenant/category/month.
    expect(existingLogKeys.has(logKey({ tenantId: TENANT, nudgeType: 'budget_alert_80', periodKey: '2026-07', category: 'groceries' }))).toBe(true);
    expect(existingLogKeys.has(logKey({ tenantId: TENANT, nudgeType: 'budget_alert_100', periodKey: '2026-07', category: 'groceries' }))).toBe(true);
  });

  it('a budget that jumps straight past both thresholds in one transaction fires BOTH 80 and 100, not just the higher one', async () => {
    budgets = [{ category: 'rent', monthlyLimitCents: 50_000 }];
    budgetTxns = [{ category: 'rent', amountCents: -60_000 }]; // 120% in one shot, first time ever checked

    const results = await checkPersonalFinanceNudges(TENANT);
    const budgetResults = results.filter((r) => r.nudgeType.startsWith('budget_alert'));
    const types = budgetResults.map((r) => r.nudgeType).sort();

    expect(types).toEqual(['budget_alert_100', 'budget_alert_80']);
    expect(budgetResults.every((r) => r.category === 'rent' && r.periodKey === '2026-07')).toBe(true);
    expect(mockNudgeLogCreate).toHaveBeenCalledTimes(2);
  });

  it('drops below threshold then re-crosses in a LATER month -> fires again (fresh periodKey)', async () => {
    budgets = [{ category: 'dining', monthlyLimitCents: 10_000 }];
    budgetTxns = [{ category: 'dining', amountCents: -8_000 }]; // 80% in July

    const july = await checkPersonalFinanceNudges(TENANT);
    expect(july.map((r) => r.nudgeType)).toContain('budget_alert_80');

    // Move to August: crosses 80% again for the same category.
    vi.setSystemTime(NOW_AUGUST);
    budgetTxns = [{ category: 'dining', amountCents: -8_000 }];

    const august = await checkPersonalFinanceNudges(TENANT);
    const augustBudget = august.filter((r) => r.nudgeType.startsWith('budget_alert'));
    expect(augustBudget).toHaveLength(1);
    expect(augustBudget[0]).toMatchObject({ nudgeType: 'budget_alert_80', category: 'dining', periodKey: '2026-08' });
    expect(mockNudgeLogCreate).toHaveBeenCalledTimes(2); // July row + August row, no collision
  });
});

describe('checkPersonalFinanceNudges — net worth month-over-month', () => {
  it('change under the noise floor -> does not fire', async () => {
    netWorthAccounts = [makeAccount({ id: 'a1', balanceCents: 1_000_000, createdAt: new Date(2020, 0, 1) })];
    // $50 swing dated in July (after June-end, before July-end) -> prior month differs by only 5000 cents.
    netWorthTxns = [makeTxn({ accountId: 'a1', date: new Date(2026, 6, 10), amountCents: 5_000 })];

    const results = await checkPersonalFinanceNudges(TENANT);
    expect(results.filter((r) => r.nudgeType === 'net_worth_update')).toHaveLength(0);
  });

  it('change over the noise floor -> fires once, dedups on repeat within the month', async () => {
    netWorthAccounts = [makeAccount({ id: 'a1', balanceCents: 1_000_000, createdAt: new Date(2020, 0, 1) })];
    // $600 swing -> exceeds max($100, 5% of ~$9400 prior net worth).
    netWorthTxns = [makeTxn({ accountId: 'a1', date: new Date(2026, 6, 10), amountCents: 60_000 })];

    const first = await checkPersonalFinanceNudges(TENANT);
    const firstNw = first.filter((r) => r.nudgeType === 'net_worth_update');
    expect(firstNw).toHaveLength(1);
    expect(firstNw[0]).toMatchObject({ nudgeType: 'net_worth_update', category: null, periodKey: '2026-07' });

    const second = await checkPersonalFinanceNudges(TENANT);
    expect(second.filter((r) => r.nudgeType === 'net_worth_update')).toHaveLength(0);
  });
});

describe('checkPersonalFinanceNudges — negative savings rate', () => {
  it('negative savings rate (spending exceeds income) -> fires', async () => {
    savingsTxns = [{ amountCents: 500_00 }, { amountCents: -600_00 }]; // $500 in, $600 out

    const results = await checkPersonalFinanceNudges(TENANT);
    const savingsResults = results.filter((r) => r.nudgeType === 'savings_warning');
    expect(savingsResults).toHaveLength(1);
    expect(savingsResults[0]).toMatchObject({ nudgeType: 'savings_warning', category: null, periodKey: '2026-07' });
  });

  it('positive savings rate -> does not fire', async () => {
    savingsTxns = [{ amountCents: 600_00 }, { amountCents: -500_00 }]; // $600 in, $500 out

    const results = await checkPersonalFinanceNudges(TENANT);
    expect(results.filter((r) => r.nudgeType === 'savings_warning')).toHaveLength(0);
  });
});
