/**
 * Categorize / re-categorize an expense + update / create the
 * vendor → category pattern so future expenses auto-categorize.
 *
 * Treats this as a high-confidence (0.95) user correction.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface CategorizeBody {
  categoryId?: string;
  source?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as CategorizeBody;
    const { categoryId, source } = body;

    if (!categoryId) {
      return NextResponse.json({ success: false, error: 'categoryId is required' }, { status: 400 });
    }

    const expense = await db.abExpense.findFirst({ where: { id, tenantId } });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    const updated = await db.abExpense.update({
      where: { id },
      data: { categoryId, confidence: 1.0 },
    });

    if (expense.vendorId) {
      const vendor = await db.abVendor.findUnique({ where: { id: expense.vendorId } });
      if (vendor) {
        await db.abPattern.upsert({
          where: { tenantId_vendorPattern: { tenantId, vendorPattern: vendor.normalizedName } },
          update: {
            categoryId,
            confidence: 0.95,
            source: source || 'user_corrected',
            usageCount: { increment: 1 },
            lastUsed: new Date(),
          },
          create: {
            tenantId,
            vendorPattern: vendor.normalizedName,
            categoryId,
            confidence: 0.95,
            source: source || 'user_corrected',
          },
        });
        await db.abVendor.update({
          where: { id: vendor.id },
          data: { defaultCategoryId: categoryId },
        });
      }
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/categorize] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
