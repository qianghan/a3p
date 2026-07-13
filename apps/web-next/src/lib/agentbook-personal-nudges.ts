/**
 * Personal-finance proactive nudge checks (PR-2 / Task 3a).
 *
 * `checkPersonalFinanceNudges()` runs three independent checks for a tenant
 * and returns the nudges that newly fired on THIS call. It does not deliver
 * anything (no createNotification()/sendToAllChannels() calls) — delivery is
 * Task 3b's cron route. This module only decides "did a nudge cross its
 * threshold, and have we already recorded it for this period" and, if it's
 * new, writes the AbPersonalNudgeLog dedup row.
 *
 * Checks (each independent — none early-returns on another firing):
 *   a. Budget-threshold — for each AbPersonalBudget, this month's spent/limit
 *      percent (same math as budget/route.ts's GET). 80% and 100% are two
 *      distinct nudgeType values (`budget_alert_80` / `budget_alert_100`),
 *      each with its own dedup row, so a budget that jumps straight past both
 *      thresholds in one transaction fires both — not just the higher one.
 *   b. Net-worth month-over-month — two points (current + prior month) from
 *      computeNetWorthTrend(), fires when the swing exceeds the noise floor
 *      max($100, 5% of prior month's net worth).
 *   c. Negative savings rate — this month's income minus spending, reusing
 *      the same income/spending split lib/personal-snapshot.ts's
 *      computeSnapshot() uses (amountCents >= 0 is income, < 0 is spend).
 *
 * Dedup mechanism: query AbPersonalNudgeLog for an existing row matching
 * (tenantId, nudgeType, periodKey, category) before firing; if found, skip
 * (not included in the returned array); if not found, insert the row and
 * include the nudge in the returned array.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { computeNetWorthTrend } from './personal-trend';

export type NudgeType =
  | 'budget_alert_80'
  | 'budget_alert_100'
  | 'net_worth_update'
  | 'savings_warning';

export interface NudgeResult {
  nudgeType: NudgeType;
  /** Budget category for budget_alert_* nudges; null for net-worth/savings nudges. */
  category: string | null;
  /** "YYYY-MM" — the period this nudge fired for; also the AbPersonalNudgeLog dedup key component. */
  periodKey: string;
  message: string;
  /** Always false for entries in the returned array — a nudge that had already
   * fired for this (tenantId, nudgeType, periodKey, category) is deduped out
   * of the results entirely, not returned with this flag set true. Kept on
   * the shape so callers have an explicit signal rather than inferring it
   * from array membership alone. */
  alreadyFired: boolean;
}

function periodKeyFor(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Dedup check + fire. Returns the fired NudgeResult, or null if a log row
 * already existed (i.e. this nudge already fired for this period). */
async function maybeFire(params: {
  tenantId: string;
  nudgeType: NudgeType;
  periodKey: string;
  category: string | null;
  message: string;
}): Promise<NudgeResult | null> {
  // Prisma's generated compound-unique lookup type for this index requires a
  // non-null `category` (composite unique inputs can't express a nullable
  // member), which doesn't fit the net-worth/savings-rate nudges (category:
  // null). findFirst with the same four fields is the equivalent read and
  // accepts `category: null` directly.
  const existing = await db.abPersonalNudgeLog.findFirst({
    where: {
      tenantId: params.tenantId,
      nudgeType: params.nudgeType,
      periodKey: params.periodKey,
      category: params.category,
    },
  });
  if (existing) return null;

  await db.abPersonalNudgeLog.create({
    data: {
      tenantId: params.tenantId,
      nudgeType: params.nudgeType,
      periodKey: params.periodKey,
      category: params.category,
    },
  });

  return {
    nudgeType: params.nudgeType,
    category: params.category,
    periodKey: params.periodKey,
    message: params.message,
    alreadyFired: false,
  };
}

async function checkBudgetThresholds(tenantId: string, now: Date, periodKey: string): Promise<NudgeResult[]> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [budgets, txns] = await Promise.all([
    db.abPersonalBudget.findMany({ where: { tenantId } }),
    db.abPersonalTransaction.findMany({
      where: { tenantId, date: { gte: monthStart }, amountCents: { lt: 0 } },
      select: { category: true, amountCents: true },
    }),
  ]);

  const spentByCategory = new Map<string, number>();
  for (const t of txns) {
    spentByCategory.set(t.category, (spentByCategory.get(t.category) || 0) + Math.abs(t.amountCents));
  }

  const results: NudgeResult[] = [];
  for (const budget of budgets) {
    const spentCents = spentByCategory.get(budget.category) || 0;
    const percent = budget.monthlyLimitCents > 0 ? Math.round((spentCents / budget.monthlyLimitCents) * 100) : 0;

    // Both thresholds are checked independently — a budget that jumps straight
    // past 100% in one transaction still gets both the 80 and 100 nudges.
    if (percent >= 80) {
      const fired = await maybeFire({
        tenantId,
        nudgeType: 'budget_alert_80',
        periodKey,
        category: budget.category,
        message: `You've spent ${percent}% of your ${budget.category} budget this month ($${formatDollars(spentCents)} of $${formatDollars(budget.monthlyLimitCents)}).`,
      });
      if (fired) results.push(fired);
    }
    if (percent >= 100) {
      const fired = await maybeFire({
        tenantId,
        nudgeType: 'budget_alert_100',
        periodKey,
        category: budget.category,
        message: `You've gone over your ${budget.category} budget this month — $${formatDollars(spentCents)} spent against a $${formatDollars(budget.monthlyLimitCents)} limit.`,
      });
      if (fired) results.push(fired);
    }
  }
  return results;
}

async function checkNetWorthChange(tenantId: string): Promise<NudgeResult[]> {
  const [accounts, transactions] = await Promise.all([
    db.abPersonalAccount.findMany({ where: { tenantId } }),
    db.abPersonalTransaction.findMany({ where: { tenantId } }),
  ]);

  // Exactly the current and prior month's points — not a full 12-month recompute.
  const trend = computeNetWorthTrend(accounts, transactions, 2);
  if (trend.length < 2) return [];
  const [priorMonth, currentMonth] = trend;

  const change = currentMonth.netWorthCents - priorMonth.netWorthCents;
  const noiseFloor = Math.max(10_000, Math.abs(priorMonth.netWorthCents) * 0.05);
  if (Math.abs(change) <= noiseFloor) return [];

  const direction = change > 0 ? 'up' : 'down';
  const fired = await maybeFire({
    tenantId,
    nudgeType: 'net_worth_update',
    periodKey: currentMonth.month,
    category: null,
    message: `Your net worth is ${direction} $${formatDollars(Math.abs(change))} this month (from $${formatDollars(priorMonth.netWorthCents)} to $${formatDollars(currentMonth.netWorthCents)}).`,
  });
  return fired ? [fired] : [];
}

async function checkNegativeSavingsRate(tenantId: string, now: Date, periodKey: string): Promise<NudgeResult[]> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthTxns = await db.abPersonalTransaction.findMany({
    where: { tenantId, date: { gte: monthStart } },
    select: { amountCents: true },
  });

  let incomeCents = 0;
  let spendingCents = 0;
  for (const t of monthTxns) {
    if (t.amountCents >= 0) incomeCents += t.amountCents;
    else spendingCents += Math.abs(t.amountCents);
  }

  const netCents = incomeCents - spendingCents;
  if (netCents >= 0) return [];

  const fired = await maybeFire({
    tenantId,
    nudgeType: 'savings_warning',
    periodKey,
    category: null,
    message: `You spent more than you earned this month — $${formatDollars(spendingCents)} out against $${formatDollars(incomeCents)} in, a shortfall of $${formatDollars(Math.abs(netCents))}.`,
  });
  return fired ? [fired] : [];
}

export async function checkPersonalFinanceNudges(tenantId: string): Promise<NudgeResult[]> {
  const now = new Date();
  const periodKey = periodKeyFor(now);

  // Each check runs independently — none early-returns on another firing.
  const [budgetResults, netWorthResults, savingsResults] = await Promise.all([
    checkBudgetThresholds(tenantId, now, periodKey),
    checkNetWorthChange(tenantId),
    checkNegativeSavingsRate(tenantId, now, periodKey),
  ]);

  return [...budgetResults, ...netWorthResults, ...savingsResults];
}
