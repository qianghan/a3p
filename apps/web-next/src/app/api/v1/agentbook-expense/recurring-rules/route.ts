/**
 * Recurring expense rules — list active rules ordered by next-expected date.
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
    const rules = await db.abRecurringRule.findMany({
      where: { tenantId, active: true },
      orderBy: { nextExpected: 'asc' },
    });
    return NextResponse.json({ success: true, data: rules });
  } catch (err) {
    console.error('[agentbook-expense/recurring-rules] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
