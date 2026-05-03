/**
 * Expense list — native Next.js route.
 *
 * Read-only port of the legacy plugin Express handler. Mutating endpoints
 * (POST/PUT, splits, auto-tag, categorize, etc.) still 501 via the
 * generic [plugin]/[...path] proxy until they are ported individually.
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
    const params = request.nextUrl.searchParams;
    const startDate = params.get('startDate');
    const endDate = params.get('endDate');
    const isPersonal = params.get('isPersonal');
    const vendorId = params.get('vendorId');
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);

    const where: Record<string, unknown> = { tenantId };
    if (startDate || endDate) {
      const date: Record<string, Date> = {};
      if (startDate) date.gte = new Date(startDate);
      if (endDate) date.lte = new Date(endDate);
      where.date = date;
    }
    if (isPersonal !== null) where.isPersonal = isPersonal === 'true';
    if (vendorId) where.vendorId = vendorId;

    const [expenses, total] = await Promise.all([
      db.abExpense.findMany({
        where,
        include: { vendor: { select: { id: true, name: true, normalizedName: true } } },
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.abExpense.count({ where }),
    ]);

    const categoryIds = [...new Set(expenses.map((e) => e.categoryId).filter((id): id is string => Boolean(id)))];
    const categories = categoryIds.length > 0
      ? await db.abAccount.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const categoryMap = Object.fromEntries(categories.map((c) => [c.id, { name: c.name, code: c.code }]));

    const enriched = expenses.map((e) => ({
      ...e,
      vendorName: e.vendor?.name || null,
      categoryName: e.categoryId ? categoryMap[e.categoryId]?.name || null : null,
      categoryCode: e.categoryId ? categoryMap[e.categoryId]?.code || null : null,
    }));

    return NextResponse.json({
      success: true,
      data: enriched,
      meta: { total, limit, offset },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
