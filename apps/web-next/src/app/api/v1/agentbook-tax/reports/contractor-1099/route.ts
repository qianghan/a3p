/**
 * 1099-NEC (US) / T4A (CA) contractor-payment threshold report — reconnects
 * packages/agentbook-framework's getContractorSummaries, which had zero
 * callers anywhere in the live app until this route.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getContractorSummaries } from '@agentbook/framework';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = cfg?.jurisdiction || 'us';
    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);

    const contractors = await getContractorSummaries(tenantId, jurisdiction, year, db);
    return NextResponse.json({ success: true, data: { year, jurisdiction, contractors } });
  } catch (err) {
    console.error('[agentbook-tax/reports/contractor-1099] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
