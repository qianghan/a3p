import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { redraftApplication } from '@/lib/agentbook-startup/redraft';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  if (!(await hasAddOn(tenantId, 'startup_tax_benefits'))) {
    return NextResponse.json({ error: 'Startup Tax Benefits add-on required' }, { status: 402 });
  }

  const { id } = await params;
  const { response } = (await request.json().catch(() => ({}))) as { response?: unknown };
  if (response == null) {
    return NextResponse.json({ error: 'response is required' }, { status: 400 });
  }

  const decisionPoint = await prisma.startupBenefitDecisionPoint.findUnique({ where: { id } });
  if (!decisionPoint) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const application = await prisma.startupBenefitApplication.findFirst({
    where: { id: decisionPoint.applicationId, tenantId }, select: { id: true },
  });
  if (!application) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  await prisma.startupBenefitDecisionPoint.update({
    where: { id },
    data: { response: response as object, respondedAt: new Date() },
  });

  const result = await redraftApplication(application.id);
  return NextResponse.json(result.body, { status: result.status });
}
