import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getJurisdictionPack } from '@agentbook/jurisdictions';
import '@/lib/agentbook-startup/discovery';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { id } = await params;

  const application = await prisma.startupBenefitApplication.findFirst({ where: { id, tenantId } });
  if (!application) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const [documents, decisionPoints, program] = await Promise.all([
    prisma.startupBenefitDocument.findMany({ where: { applicationId: id }, orderBy: { uploadedAt: 'asc' } }),
    prisma.startupBenefitDecisionPoint.findMany({ where: { applicationId: id }, orderBy: { sequenceOrder: 'asc' } }),
    prisma.startupBenefitProgram.findUnique({ where: { id: application.programId } }),
  ]);

  const documentChecklist = program
    ? getJurisdictionPack(program.jurisdiction)?.taxBenefits?.getRequiredDocuments(program.programCode) ?? []
    : [];

  return NextResponse.json({ application, documents, decisionPoints, documentChecklist });
}
