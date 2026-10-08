/**
 * Dashboard metrics shared by GET /agentbook-core/dashboard/overview and
 * GET /agentbook-core/mobile/home — one definition per number.
 *
 * Moved from dashboard/overview/route.ts (same local-time month boundaries).
 * The month aggregates exclude SOFT-DELETED expenses (a deleted expense is
 * not spending) but deliberately keep ARCHIVED ones: archive files a doc
 * away, it must not move totals. Expense status is not filtered (pending /
 * rejected rows stay in the month net — a separate product decision).
 */
import 'server-only';
import { prisma as db } from '@naap/database';

export interface MonthTotals {
  revenueCents: number;
  expenseCents: number;
  netCents: number;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function startOfPrevMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

/** Cash today: sum of (debit − credit) on journal lines of active asset accounts. */
export async function getCashTodayCents(tenantId: string): Promise<number> {
  const assetAccounts = await db.abAccount.findMany({
    where: { tenantId, accountType: 'asset', isActive: true },
    select: {
      id: true,
      journalLines: { select: { debitCents: true, creditCents: true } },
    },
  });
  return assetAccounts.reduce((sum, account) => {
    const accountBalance = account.journalLines.reduce(
      (acc, line) => acc + line.debitCents - line.creditCents,
      0,
    );
    return sum + accountBalance;
  }, 0);
}

/** Month-to-date and prior-month revenue (payments) and business expenses. */
export async function getMonthTotals(
  tenantId: string,
  today: Date,
): Promise<{ monthMtd: MonthTotals; monthPrev: MonthTotals }> {
  const [mtdExpenses, mtdRevenue, prevExpenses, prevRevenue] = await Promise.all([
    db.abExpense.aggregate({
      where: { tenantId, isPersonal: false, deletedAt: null, date: { gte: startOfMonth(today) } },
      _sum: { amountCents: true },
    }),
    db.abPayment.aggregate({
      where: { tenantId, date: { gte: startOfMonth(today) } },
      _sum: { amountCents: true },
    }),
    db.abExpense.aggregate({
      where: {
        tenantId,
        isPersonal: false,
        deletedAt: null,
        date: { gte: startOfPrevMonth(today), lt: startOfMonth(today) },
      },
      _sum: { amountCents: true },
    }),
    db.abPayment.aggregate({
      where: {
        tenantId,
        date: { gte: startOfPrevMonth(today), lt: startOfMonth(today) },
      },
      _sum: { amountCents: true },
    }),
  ]);
  const totals = (rev: number | null, exp: number | null): MonthTotals => ({
    revenueCents: rev || 0,
    expenseCents: exp || 0,
    netCents: (rev || 0) - (exp || 0),
  });
  return {
    monthMtd: totals(mtdRevenue._sum.amountCents, mtdExpenses._sum.amountCents),
    monthPrev: totals(prevRevenue._sum.amountCents, prevExpenses._sum.amountCents),
  };
}

/** The overview reports a month as null when nothing moved in it. */
export function nonEmptyMonth(m: MonthTotals): MonthTotals | null {
  return m.revenueCents > 0 || m.expenseCents > 0 ? m : null;
}

export async function isBrandNewTenant(tenantId: string): Promise<boolean> {
  const [expenseCount, invoiceCount] = await Promise.all([
    db.abExpense.count({ where: { tenantId } }),
    db.abInvoice.count({ where: { tenantId } }),
  ]);
  return expenseCount === 0 && invoiceCount === 0;
}
