import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { runAuditReview } from '@/lib/agentbook-startup/audit-review';

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
  const owned = await prisma.startupBenefitApplication.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!owned) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const result = await runAuditReview(id);
  return NextResponse.json(result.body, { status: result.status });
}
