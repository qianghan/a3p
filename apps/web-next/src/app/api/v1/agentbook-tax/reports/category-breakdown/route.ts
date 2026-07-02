/**
 * Expense category breakdown for a date range — powers the Analytics page's
 * "Category Breakdown" chart.
 *
 * QA-P3-001: this route never had a native handler (unlike its siblings
 * pnl/cashflow/trial-balance), so requests fell through to the generic
 * `[plugin]/[...path]` proxy, which tries to reach a pre-Next.js standalone
 * backend that doesn't exist in this architecture — always 503ing.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function parseDate(val: string | null, fallback: Date): Date {
  if (!val) return fallback;
  const d = new Date(val);
  return isNaN(d.getTime()) ? fallback : d;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const startDate = parseDate(params.get('startDate'), yearStart);
    const endDate = parseDate(params.get('endDate'), new Date());

    const grouped = await db.abExpense.groupBy({
      by: ['categoryId'],
      where: { tenantId, isPersonal: false, deletedAt: null, date: { gte: startDate, lte: endDate } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });

    const categoryIds = grouped.map((g) => g.categoryId).filter((id): id is string => Boolean(id));
    const categories = categoryIds.length > 0
      ? await db.abAccount.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
      : [];
    const nameMap = new Map(categories.map((c) => [c.id, c.name]));

    const totalCents = grouped.reduce((s, g) => s + (g._sum.amountCents || 0), 0);

    const data = grouped
      .map((g) => ({
        categoryName: g.categoryId ? nameMap.get(g.categoryId) || 'Uncategorized' : 'Uncategorized',
        totalCents: g._sum.amountCents || 0,
        count: g._count._all,
        percentOfTotal: totalCents > 0 ? (g._sum.amountCents || 0) / totalCents : 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[agentbook-tax/reports/category-breakdown] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
