/**
 * Expense detail + edit.
 *
 * GET — full row + resolved vendor name + category name/code + splits.
 * PUT — patch amountCents, categoryId, description, isPersonal, date.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;

    const expense = await db.abExpense.findFirst({
      where: { id, tenantId },
      include: { vendor: { select: { id: true, name: true } } },
    });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    let categoryName: string | null = null;
    let categoryCode: string | null = null;
    if (expense.categoryId) {
      const cat = await db.abAccount.findFirst({ where: { id: expense.categoryId } });
      if (cat) {
        categoryName = cat.name;
        categoryCode = cat.code;
      }
    }

    const splits = await db.abExpenseSplit.findMany({ where: { expenseId: expense.id } });

    return NextResponse.json({
      success: true,
      data: {
        ...expense,
        vendorName: expense.vendor?.name || null,
        categoryName,
        categoryCode,
        splits,
      },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface UpdateExpenseBody {
  amountCents?: number;
  categoryId?: string;
  description?: string;
  isPersonal?: boolean;
  date?: string;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as UpdateExpenseBody;
    const existing = await db.abExpense.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.amountCents !== undefined) data.amountCents = body.amountCents;
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.description !== undefined) data.description = body.description;
    if (body.isPersonal !== undefined) data.isPersonal = body.isPersonal;
    if (body.date !== undefined) data.date = new Date(body.date);

    const updated = await db.abExpense.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
