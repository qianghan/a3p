/**
 * GET /api/v1/agentbook-tax/reports/contractor-1099/pdf?year=&contractorName=
 * — serves a real T4A PDF for one CA contractor who has crossed the
 * reporting threshold. US tenants get a 400 (1099-NEC generation is a
 * separate, not-yet-built capability — this route is CA-T4A-specific,
 * matching this PR's scope).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getContractorSummaries } from '@agentbook/framework/src/skills/contractor-reporting/handler.js';
import { renderT4APdf } from '@/lib/payroll-forms-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = cfg?.jurisdiction || 'us';
    if (jurisdiction !== 'ca') {
      return NextResponse.json({ success: false, error: 'T4A generation is only available for Canadian tenants' }, { status: 400 });
    }

    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);
    const contractorName = request.nextUrl.searchParams.get('contractorName');
    if (!contractorName) {
      return NextResponse.json({ success: false, error: 'contractorName required' }, { status: 400 });
    }

    const contractors = await getContractorSummaries(tenantId, jurisdiction, year, db);
    const match = contractors.find((c) => c.contractorName === contractorName);
    if (!match) {
      return NextResponse.json({ success: false, error: `no contractor payments found for "${contractorName}" in ${year}` }, { status: 404 });
    }
    if (!match.requiresReporting) {
      return NextResponse.json({ success: false, error: `${contractorName} has not crossed the $500 T4A reporting threshold for ${year}` }, { status: 400 });
    }

    const pdf = await renderT4APdf({
      payerName: cfg?.companyName || 'AgentBook',
      recipientName: match.contractorName,
      year,
      feesForServicesCents: match.totalPaidCents,
    });

    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="T4A-${contractorName.replace(/\s+/g, '-')}-${year}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/contractor-1099/pdf] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
