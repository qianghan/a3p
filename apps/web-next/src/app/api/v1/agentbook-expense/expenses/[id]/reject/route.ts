/**
 * Reject a pending expense — flip status to "rejected".
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;

    const expense = await db.abExpense.findFirst({ where: { id, tenantId } });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    const updated = await db.abExpense.update({ where: { id }, data: { status: 'rejected' } });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'expense.rejected',
        actor: 'user',
        action: { expenseId: id },
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/reject] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
