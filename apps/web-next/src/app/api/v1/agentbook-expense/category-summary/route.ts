/**
 * Expense category-summary — native Next.js route.
 *
 * Groups business expenses by category for a date range, with optional
 * comparison-period and top-vendors-per-category. Powers the
 * expense-breakdown agent skill and the expenses-page advisor.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ExpenseRow {
  amountCents: number;
  categoryId: string | null;
  vendor?: { name: string } | null;
  date: Date;
  isPersonal: boolean;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const startDate = params.get('startDate');
    const endDate = params.get('endDate');
    const compareStartDate = params.get('compareStartDate');
    const compareEndDate = params.get('compareEndDate');

    const currentWhere: Record<string, unknown> = { tenantId, isPersonal: false };
    if (startDate || endDate) {
      const date: Record<string, Date> = {};
      if (startDate) date.gte = new Date(startDate);
      if (endDate) date.lte = new Date(endDate);
      currentWhere.date = date;
    }

    const currentExpenses = await db.abExpense.findMany({
      where: currentWhere,
      include: { vendor: { select: { name: true } } },
    });

    const compareExpenses: ExpenseRow[] = compareStartDate && compareEndDate
      ? await db.abExpense.findMany({
          where: {
            tenantId,
            isPersonal: false,
            date: { gte: new Date(compareStartDate), lte: new Date(compareEndDate) },
          },
        })
      : [];

    const categoryIds = [...new Set(currentExpenses.map((e) => e.categoryId).filter((id): id is string => Boolean(id)))];
    const categories = categoryIds.length > 0
      ? await db.abAccount.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const catMap = Object.fromEntries(categories.map((c) => [c.id, c]));

    const compareByCat: Record<string, number> = {};
    for (const e of compareExpenses) {
      const key = e.categoryId || 'uncategorized';
      compareByCat[key] = (compareByCat[key] || 0) + e.amountCents;
    }

    const byCat: Record<string, { totalCents: number; count: number; expenses: ExpenseRow[] }> = {};
    for (const e of currentExpenses) {
      const key = e.categoryId || 'uncategorized';
      if (!byCat[key]) byCat[key] = { totalCents: 0, count: 0, expenses: [] };
      byCat[key].totalCents += e.amountCents;
      byCat[key].count++;
      byCat[key].expenses.push(e);
    }

    const summary = Object.entries(byCat).map(([catId, data]) => {
      const cat = catMap[catId];
      const prevTotal = compareByCat[catId] || 0;
      const changePercent = prevTotal > 0
        ? Math.round(((data.totalCents - prevTotal) / prevTotal) * 100)
        : null;

      const vendorTotals: Record<string, number> = {};
      for (const e of data.expenses) {
        const vn = e.vendor?.name || 'Other';
        vendorTotals[vn] = (vendorTotals[vn] || 0) + e.amountCents;
      }
      const topVendors = Object.entries(vendorTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, cents]) => ({ name, totalCents: cents }));

      return {
        categoryId: catId === 'uncategorized' ? null : catId,
        categoryName: cat?.name || 'Uncategorized',
        categoryCode: cat?.code || null,
        totalCents: data.totalCents,
        count: data.count,
        previousPeriodCents: prevTotal,
        changePercent,
        topVendors,
      };
    }).sort((a, b) => b.totalCents - a.totalCents);

    const personalWhere: Record<string, unknown> = { tenantId, isPersonal: true };
    if (startDate || endDate) {
      const date: Record<string, Date> = {};
      if (startDate) date.gte = new Date(startDate);
      if (endDate) date.lte = new Date(endDate);
      personalWhere.date = date;
    }
    const personalExpenses = await db.abExpense.findMany({ where: personalWhere });
    const personalTotal = personalExpenses.reduce((s, e) => s + e.amountCents, 0);

    return NextResponse.json({
      success: true,
      data: {
        categories: summary,
        totals: {
          businessCents: currentExpenses.reduce((s, e) => s + e.amountCents, 0),
          personalCents: personalTotal,
          businessCount: currentExpenses.length,
          personalCount: personalExpenses.length,
        },
      },
    });
  } catch (err) {
    console.error('[agentbook-expense/category-summary] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
