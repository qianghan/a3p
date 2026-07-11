import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getJurisdictionPack } from '@agentbook/jurisdictions';
import '@/lib/agentbook-startup/discovery';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  if (!(await hasAddOn(tenantId, 'startup_tax_benefits'))) {
    return NextResponse.json({ error: 'Startup Tax Benefits add-on required' }, { status: 402 });
  }

  const { programCode } = (await request.json().catch(() => ({}))) as { programCode?: string };
  if (!programCode) {
    return NextResponse.json({ error: 'programCode is required' }, { status: 400 });
  }

  const program = await prisma.startupBenefitProgram.findFirst({ where: { programCode } });
  if (!program) {
    return NextResponse.json({ error: 'unknown program' }, { status: 404 });
  }

  const application = await prisma.startupBenefitApplication.create({
    data: { tenantId, programId: program.id, status: 'docs_pending', draft: {} },
  });

  const pack = getJurisdictionPack(program.jurisdiction);
  const documentChecklist = pack?.taxBenefits?.getRequiredDocuments(programCode) ?? [];

  return NextResponse.json({ application, documentChecklist });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const applications = await prisma.startupBenefitApplication.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ applications });
}
