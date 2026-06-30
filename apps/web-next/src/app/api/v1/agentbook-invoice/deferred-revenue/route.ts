/**
 * Deferred revenue schedules — list + summary.
 *
 * GET: returns each active/completed deferral row for the tenant plus a
 * roll-up of total billed, recognized, and unearned (still-deferred) cents.
 * Read-only; recognition itself happens in the recognize-revenue cron.
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

    const rows = await db.abDeferredRevenue.findMany({
      where: { tenantId },
      orderBy: { startDate: 'desc' },
    });

    const totalBilledCents = rows.reduce((s, r) => s + r.totalAmountCents, 0);
    const recognizedCents = rows.reduce((s, r) => s + r.recognizedAmountCents, 0);
    const unearnedCents = totalBilledCents - recognizedCents;

    return NextResponse.json({
      success: true,
      data: rows,
      summary: { totalBilledCents, recognizedCents, unearnedCents },
    });
  } catch (err) {
    console.error('[agentbook-invoice/deferred-revenue GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
