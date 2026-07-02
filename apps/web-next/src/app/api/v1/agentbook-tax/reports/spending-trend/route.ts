/**
 * Monthly spending trend (last N months) — powers the Analytics page's
 * "Monthly Spending Trend" chart. Same missing-route/503 bug as
 * category-breakdown (QA-P3-001) — no native handler existed for this path.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const months = Math.min(24, Math.max(1, parseInt(request.nextUrl.searchParams.get('months') || '6', 10) || 6));

    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const expenses = await db.abExpense.findMany({
      where: { tenantId, isPersonal: false, deletedAt: null, date: { gte: rangeStart } },
      select: { amountCents: true, date: true },
    });

    const totalsByMonth = new Map<string, number>();
    for (const e of expenses) {
      const key = monthKey(new Date(e.date));
      totalsByMonth.set(key, (totalsByMonth.get(key) || 0) + e.amountCents);
    }

    const data: Array<{ month: string; totalCents: number; changePercent: number | null }> = [];
    let prevTotal: number | null = null;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = monthKey(d);
      const totalCents = totalsByMonth.get(key) || 0;
      const changePercent = prevTotal && prevTotal > 0 ? ((totalCents - prevTotal) / prevTotal) * 100 : null;
      data.push({ month: key, totalCents, changePercent });
      prevTotal = totalCents;
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[agentbook-tax/reports/spending-trend] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
