/**
 * POST /api/v1/agentbook-expense/expenses/:id/archive — hide an expense from
 * default lists. No journal entry, no total change; idempotent.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { setExpenseArchived } from '@/lib/mobile/archive';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    const outcome = await setExpenseArchived(tenantId, id, true);
    if (!outcome.ok) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }
    if (outcome.changed) {
      await audit({
        tenantId,
        source: inferSource(request),
        actor: await inferActor(request),
        action: 'expense.archive',
        entityType: 'AbExpense',
        entityId: id,
        before: { archivedAt: null },
        after: { archivedAt: outcome.archivedAt },
      });
    }
    return NextResponse.json({
      success: true,
      data: { id, archivedAt: outcome.archivedAt ? outcome.archivedAt.toISOString() : null },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/archive] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
