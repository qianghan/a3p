/**
 * Dashboard /overview — minimal native Next.js route.
 *
 * Computes only the slices the new dashboard actually consumes:
 *   • cashToday from cash/bank accounts only (A/R excluded; null = no cash account)
 *   • attention queue (overdue invoices, tax window, missing receipts,
 *     books-out-of-balance)
 *   • next-moments (overdue invoice payments + auto-detected recurring)
 *   • recurring outflows (auto-detected from expense history)
 *   • this-month metrics (Rev/Exp/Net + prior month)
 *   • isBrandNew flag
 *
 * Cash, month totals and the brand-new flag come from
 * lib/agentbook-dashboard-metrics.ts, shared with GET /mobile/home.
 *
 * Intentionally omitted (returns null/empty for the dashboard to handle):
 *   • cashflow projection (30-day forecasting math) — V2
 *   • quarterly tax estimate calc — V2
 *   • unbilled time aggregate — V2
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import {
  rankAttention,
  buildNextMoments,
  detectRecurringFromHistory,
  resolveTenantId,
  type AttentionItem,
  type NextMoment,
  type RecurringOutflow,
} from '../_helpers';
import {
  getCashTodayCents,
  getMonthTotals,
  nonEmptyMonth,
  isBrandNewTenant,
} from '@/lib/agentbook-dashboard-metrics';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await resolveTenantId(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const today = new Date();

    const [
      cashToday,
      overdueInvoices,
      upcomingInvoices,
      missingReceiptsCount,
      months,
      isBrandNew,
      ninetyDayExpenses,
    ] = await Promise.all([
      getCashTodayCents(tenantId),

      // Overdue invoices (soft-deleted ones keep their status — skip them)
      db.abInvoice.findMany({
        where: { tenantId, deletedAt: null, status: { in: ['sent', 'overdue', 'viewed'] }, dueDate: { lt: today } },
        select: { id: true, dueDate: true, amountCents: true, client: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 10,
      }),

      // Upcoming invoices (next 30 days)
      db.abInvoice.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['sent', 'viewed'] },
          dueDate: { gte: today, lte: daysFromNow(30) },
        },
        select: { id: true, dueDate: true, amountCents: true, client: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 10,
      }),

      // Missing receipts count (last 60 days)
      db.abExpense.count({
        where: {
          tenantId,
          isPersonal: false,
          receiptUrl: null,
          date: { gte: daysAgo(60) },
        },
      }),

      getMonthTotals(tenantId, today),

      isBrandNewTenant(tenantId),

      // 90-day expense window for recurring-outflow detection
      db.abExpense.findMany({
        where: { tenantId, isPersonal: false, date: { gte: daysAgo(90) } },
        select: {
          id: true,
          description: true,
          amountCents: true,
          date: true,
          vendor: { select: { name: true } },
        },
      }),
    ]);

    const overdueForRanking = overdueInvoices.map((i) => ({
      id: i.id,
      client: i.client?.name || 'Client',
      daysOverdue: Math.max(1, Math.round((today.getTime() - i.dueDate.getTime()) / 86_400_000)),
      amountCents: i.amountCents,
    }));

    const upcomingForMoments = upcomingInvoices.map((i) => ({
      client: i.client?.name || 'Client',
      amountCents: i.amountCents,
      daysOut: Math.max(0, Math.round((i.dueDate.getTime() - today.getTime()) / 86_400_000)),
      sourceId: i.id,
    }));

    const recurring = detectRecurringFromHistory(
      ninetyDayExpenses.map((e) => ({
        id: e.id,
        vendor: e.vendor?.name || e.description || '',
        amountCents: e.amountCents,
        date: e.date,
      })),
      today,
    );
    const recurringWithDays = recurring.map((r) => ({
      ...r,
      daysOut: Math.max(0, Math.round((new Date(r.nextExpectedDate).getTime() - today.getTime()) / 86_400_000)),
    }));

    const attention: AttentionItem[] = rankAttention({
      overdue: overdueForRanking,
      taxQuarterly: null,
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount,
    });

    const nextMoments: NextMoment[] = buildNextMoments({
      upcomingInvoices: upcomingForMoments,
      tax: null,
      recurring: recurringWithDays.filter((r) => r.daysOut <= 30),
    });

    return NextResponse.json({
      success: true,
      data: {
        cashToday,
        projection: null,             // V2: cashflow forecast
        nextMoments,
        attention,
        recurringOutflows: recurring as RecurringOutflow[],
        monthMtd: nonEmptyMonth(months.monthMtd),
        monthPrev: nonEmptyMonth(months.monthPrev),
        isBrandNew,
      },
    });
  } catch (err) {
    console.error('[dashboard/overview] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
