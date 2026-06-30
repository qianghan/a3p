/**
 * AI-CPA review — list past reports (GET) and run a fresh review (POST).
 *
 * The review gathers a snapshot of the tenant's books and runs the pure
 * jurisdiction-aware rule engine (see lib/cpa-run + lib/cpa-review), upserting
 * an AbCpaReviewReport for the current month.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { runReviewForTenant } from '@/lib/cpa-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const reports = await db.abCpaReviewReport.findMany({
      where: { tenantId },
      orderBy: { period: 'desc' },
      take: 24,
    });
    return NextResponse.json({ success: true, data: reports });
  } catch (err) {
    console.error('[agentbook-cpa/review GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const report = await runReviewForTenant(tenantId);
    return NextResponse.json({ success: true, data: report });
  } catch (err) {
    console.error('[agentbook-cpa/review POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
