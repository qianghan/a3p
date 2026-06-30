/**
 * Server-side AI-CPA review runner: gather a tenant's books metrics, run the
 * pure rule engine, and upsert the report for the current month. Shared by the
 * on-demand review route and the monthly cron.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { runCpaReview, type ReviewMetrics } from '@/lib/cpa-review';

export function currentMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function quarterlyDueSoon(now = new Date()): boolean {
  const year = now.getFullYear();
  const deadlines = [
    new Date(year, 0, 15), new Date(year, 3, 15), new Date(year, 5, 15),
    new Date(year, 8, 15), new Date(year + 1, 0, 15),
  ];
  return deadlines.some((d) => {
    const days = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return days >= 0 && days <= 30;
  });
}

export async function runReviewForTenant(tenantId: string) {
  const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const jurisdiction = cfg?.jurisdiction || 'us';
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const now = new Date();

  const [uncategorizedExpenseCount, missingReceiptCount, openBills, revenueAccounts, expenseAccounts, cashAccount] = await Promise.all([
    db.abExpense.count({ where: { tenantId, deletedAt: null, status: 'confirmed', categoryId: null } }),
    db.abExpense.count({ where: { tenantId, deletedAt: null, status: 'confirmed', receiptUrl: null } }),
    db.abBill.findMany({ where: { tenantId, status: 'open' } }),
    db.abAccount.findMany({ where: { tenantId, accountType: 'revenue', isActive: true }, select: { id: true } }),
    db.abAccount.findMany({ where: { tenantId, accountType: 'expense', isActive: true }, select: { id: true } }),
    db.abAccount.findFirst({ where: { tenantId, code: '1000' }, select: { id: true } }),
  ]);

  const overdue = openBills.filter((b) => b.dueDate < now);

  // Cash on hand = debits − credits on the cash account (no stored balance).
  const cashAgg = cashAccount
    ? await db.abJournalLine.aggregate({ where: { accountId: cashAccount.id, entry: { tenantId } }, _sum: { debitCents: true, creditCents: true } })
    : { _sum: { debitCents: 0, creditCents: 0 } };
  const cashOnHandCents = (cashAgg._sum.debitCents || 0) - (cashAgg._sum.creditCents || 0);

  const [revAgg, expAgg] = await Promise.all([
    revenueAccounts.length
      ? db.abJournalLine.aggregate({ where: { accountId: { in: revenueAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } }, _sum: { creditCents: true, debitCents: true } })
      : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
    expenseAccounts.length
      ? db.abJournalLine.aggregate({ where: { accountId: { in: expenseAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } }, _sum: { creditCents: true, debitCents: true } })
      : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
  ]);

  const revenueCents = (revAgg._sum.creditCents || 0) - (revAgg._sum.debitCents || 0);
  const expensesCents = (expAgg._sum.debitCents || 0) - (expAgg._sum.creditCents || 0);
  const netIncomeCents = Math.max(0, revenueCents - expensesCents);
  const estimatedTaxCents = Math.round(netIncomeCents * 0.25);
  const effectiveTaxRate = netIncomeCents > 0 ? (estimatedTaxCents / netIncomeCents) * 100 : 0;

  const metrics: ReviewMetrics = {
    jurisdiction,
    uncategorizedExpenseCount,
    missingReceiptCount,
    overdueBillCount: overdue.length,
    overdueBillCents: overdue.reduce((s, b) => s + b.amountCents, 0),
    effectiveTaxRate,
    netIncomeCents,
    estimatedTaxCents,
    cashOnHandCents,
    quarterlyTaxDueSoon: quarterlyDueSoon(now),
  };

  const { findings, score } = runCpaReview(metrics);
  const period = currentMonthKey();

  return db.abCpaReviewReport.upsert({
    where: { tenantId_period: { tenantId, period } },
    update: { jurisdiction, findings, score, status: 'published' },
    create: { tenantId, period, jurisdiction, findings, score, status: 'published' },
  });
}
