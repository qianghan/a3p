/**
 * Expense review queue — list of pending_review expenses with
 * vendor + category names resolved.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);

    const expenses = await db.abExpense.findMany({
      where: { tenantId, status: 'pending_review' },
      include: { vendor: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const catIds = [...new Set(expenses.map((e) => e.categoryId).filter((id): id is string => Boolean(id)))];
    const categories = catIds.length > 0
      ? await db.abAccount.findMany({ where: { id: { in: catIds } } })
      : [];
    const catMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));

    const enriched = expenses.map((e) => ({
      ...e,
      vendorName: e.vendor?.name || null,
      categoryName: e.categoryId ? catMap[e.categoryId] || null : null,
    }));

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error('[agentbook-expense/review-queue] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
