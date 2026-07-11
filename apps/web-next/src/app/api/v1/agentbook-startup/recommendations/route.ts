import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { computeRecommendations } from '@/lib/agentbook-startup/discovery';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  try {
    const profile = await prisma.startupBenefitProfile.findUnique({ where: { tenantId } });
    if (!profile) {
      return NextResponse.json({ error: 'complete your company profile first' }, { status: 400 });
    }

    const tenantConfig = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction ?? 'us';

    const catalogRows = await prisma.startupBenefitProgram.findMany({ where: { jurisdiction, enabled: true } });
    const catalog = catalogRows.map((row) => ({
      programCode: row.programCode, name: row.name, authority: row.authority, sourceUrl: row.sourceUrl,
    }));

    const result = computeRecommendations(jurisdiction, {
      companyType: profile.companyType ?? undefined,
      incorporatedAt: profile.incorporatedAt ?? undefined,
      headcount: profile.headcount ?? undefined,
      annualRdSpendCents: profile.annualRdSpendCents ?? undefined,
      equityRaisedCents: profile.equityRaisedCents ?? undefined,
    }, catalog);

    // Audit-trail log, non-blocking — never let a logging failure break the response.
    for (const program of result.programs) {
      const catalogRow = catalogRows.find((c) => c.programCode === program.programCode);
      if (!catalogRow) continue;
      prisma.startupBenefitEligibilityAssessment.create({
        data: {
          tenantId, programId: catalogRow.id, status: program.status,
          confidence: program.confidence, reasoning: program.reasoning,
          estValueLowCents: program.estValueLowCents, estValueHighCents: program.estValueHighCents,
        },
      }).catch((err: unknown) => console.error('[agentbook-startup] failed to log eligibility assessment', err));
    }

    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[agentbook-startup] recommendations failed:', error);
    return NextResponse.json(
      { error: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') },
      { status: 500 },
    );
  }
}
