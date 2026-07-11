import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const profile = await prisma.startupBenefitProfile.findUnique({ where: { tenantId } });
  return NextResponse.json({ profile });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const { companyType, incorporatedAt, headcount, annualRdSpendCents, equityRaisedCents } = await request.json().catch(() => ({}));
  const data = {
    companyType: companyType ?? null,
    incorporatedAt: incorporatedAt ? new Date(incorporatedAt) : null,
    headcount: typeof headcount === 'number' ? headcount : null,
    annualRdSpendCents: typeof annualRdSpendCents === 'number' ? annualRdSpendCents : null,
    equityRaisedCents: typeof equityRaisedCents === 'number' ? equityRaisedCents : null,
    lastAssessedAt: new Date(),
  };
  const profile = await prisma.startupBenefitProfile.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });
  return NextResponse.json({ profile });
}
