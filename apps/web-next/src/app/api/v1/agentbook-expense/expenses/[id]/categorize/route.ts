/**
 * Categorize / re-categorize an expense. The writes (category, ledger
 * backfill or — for a booked expense whose category changes — a repost of its
 * journal entry, vendor-pattern learning, confidence policy by `source`) live in
 * lib/agentbook-categorize-expense.ts, shared with the mobile bulk review.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { categorizeExpense, type CategorizeInput } from '@/lib/agentbook-categorize-expense';
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
    const body = (await request.json().catch(() => ({}))) as CategorizeInput;

    const outcome = await categorizeExpense(tenantId, id, body);
    if (!outcome.ok) {
      // invalid_category and the ledger refusals (period_closed / split_entry /
      // already_reversed → 422, conflict → 409) carry a machine code so a
      // client can localize it; a closed period also carries the PATCH route's
      // period_gate details.
      const code = 'code' in outcome ? { code: outcome.code } : {};
      const details = 'details' in outcome && outcome.details ? { details: outcome.details } : {};
      return NextResponse.json({ success: false, ...code, error: outcome.error, ...details }, { status: outcome.status });
    }
    return NextResponse.json({ success: true, data: outcome.expense });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/categorize] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
