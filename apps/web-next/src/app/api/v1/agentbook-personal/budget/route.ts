/**
 * Personal monthly budgets — list (with this-month spend) + upsert.
 *
 * Spend for the current calendar month is computed from outflow transactions
 * (negative amounts) grouped by category, so each budget shows limit, spent,
 * and remaining.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [budgets, txns] = await Promise.all([
      db.abPersonalBudget.findMany({ where: { tenantId }, orderBy: { category: 'asc' } }),
      db.abPersonalTransaction.findMany({
        where: { tenantId, date: { gte: monthStart }, amountCents: { lt: 0 } },
        select: { category: true, amountCents: true },
      }),
    ]);

    const spentByCategory = new Map<string, number>();
    for (const t of txns) {
      spentByCategory.set(t.category, (spentByCategory.get(t.category) || 0) + Math.abs(t.amountCents));
    }

    const data = budgets.map((b) => {
      const spentCents = spentByCategory.get(b.category) || 0;
      return {
        ...b,
        spentCents,
        remainingCents: b.monthlyLimitCents - spentCents,
        percent: b.monthlyLimitCents > 0 ? Math.round((spentCents / b.monthlyLimitCents) * 100) : 0,
      };
    });

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[agentbook-personal/budget GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface BudgetBody { category?: string; monthlyLimitCents?: number }

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as BudgetBody;
    if (!body.category || typeof body.monthlyLimitCents !== 'number' || body.monthlyLimitCents < 0) {
      return NextResponse.json({ success: false, error: 'category and non-negative monthlyLimitCents are required' }, { status: 400 });
    }
    const budget = await db.abPersonalBudget.upsert({
      where: { tenantId_category: { tenantId, category: body.category } },
      update: { monthlyLimitCents: body.monthlyLimitCents },
      create: { tenantId, category: body.category, monthlyLimitCents: body.monthlyLimitCents },
    });
    return NextResponse.json({ success: true, data: budget }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-personal/budget POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
