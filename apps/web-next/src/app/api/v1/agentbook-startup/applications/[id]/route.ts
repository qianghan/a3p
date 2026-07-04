import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

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

  const [documents, decisionPoints] = await Promise.all([
    prisma.startupBenefitDocument.findMany({ where: { applicationId: id }, orderBy: { uploadedAt: 'asc' } }),
    prisma.startupBenefitDecisionPoint.findMany({ where: { applicationId: id }, orderBy: { sequenceOrder: 'asc' } }),
  ]);

  return NextResponse.json({ application, documents, decisionPoints });
}
