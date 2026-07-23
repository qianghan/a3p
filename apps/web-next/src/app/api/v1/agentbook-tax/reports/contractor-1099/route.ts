/**
 * 1099-NEC (US) / T4A (CA) contractor-payment threshold report — reconnects
 * packages/agentbook-framework's getContractorSummaries, which had zero
 * callers anywhere in the live app until this route.
 *
 * Imported via a direct subpath (not the package's index.ts barrel, which
 * re-exports a large, unrelated, unused orchestration-engine — Orchestrator,
 * LLMGateway, multi-agent system, etc.). Importing through the barrel pulls
 * all of that into this file's type-check graph for no reason; this subpath
 * import keeps the coupling to exactly the one function this route uses.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getContractorSummaries } from '@agentbook/framework/src/skills/contractor-reporting/handler.js';

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

    // Only US (1099-NEC) and CA (T4A) have real contractor-reporting logic in
    // getContractorSummaries. For any other jurisdiction the handler silently
    // fell back to the US form + US $600 threshold + US calendar year — a wrong
    // form for an AU/UK tenant. Gate here (mirroring the CA-only PDF sibling)
    // instead of emitting a US 1099-NEC to a non-US/CA tenant.
    if (jurisdiction !== 'us' && jurisdiction !== 'ca') {
      return NextResponse.json(
        { success: false, error: { code: 'unsupported_jurisdiction', message: `Contractor-payment reporting (1099-NEC / T4A) is only available for US and CA tenants, not "${jurisdiction}".` } },
        { status: 422 },
      );
    }

    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);

    const contractors = await getContractorSummaries(tenantId, jurisdiction, year, db);
    return NextResponse.json({ success: true, data: { year, jurisdiction, contractors } });
  } catch (err) {
    console.error('[agentbook-tax/reports/contractor-1099] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
