import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

interface AuditFindingLike { severity: 'low' | 'medium' | 'high' }
interface OverrideRecord { findingIndex: number; reason: string | null; overriddenAt: string }

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
  const application = await prisma.startupBenefitApplication.findFirst({ where: { id, tenantId } });
  if (!application) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const review = await prisma.startupBenefitAuditReview.findUnique({ where: { applicationId: id } });
  if (!review) {
    return NextResponse.json({ error: 'no audit review found for this application' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const findingIndex = body.findingIndex;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const findings = review.findings as unknown as AuditFindingLike[];
  if (typeof findingIndex !== 'number' || !findings[findingIndex]) {
    return NextResponse.json({ error: 'invalid findingIndex' }, { status: 400 });
  }

  const finding = findings[findingIndex];
  if (finding.severity === 'high' && !reason) {
    return NextResponse.json({ error: 'a written reason is required to override a high-severity finding' }, { status: 400 });
  }

  // Known limitation: read-modify-write with no transaction/version guard.
  // Two overrides on different findings for the same application racing
  // here can drop one silently (last write wins). Narrow blast radius (two
  // near-simultaneous overrides on one application) — acceptable for now,
  // worth a follow-up if it proves to matter in practice.
  const existingOverrides = (review.overrides as unknown as OverrideRecord[] | null) ?? [];
  const overrides = [
    ...existingOverrides.filter((o) => o.findingIndex !== findingIndex),
    { findingIndex, reason: reason || null, overriddenAt: new Date().toISOString() },
  ];

  const updatedReview = await prisma.startupBenefitAuditReview.update({
    where: { applicationId: id },
    data: { overrides: overrides as object },
  });

  const stillBlockingHigh = findings.some((f, i) => f.severity === 'high' && !overrides.some((o) => o.findingIndex === i));
  const updatedApplication = stillBlockingHigh
    ? application
    : await prisma.startupBenefitApplication.update({ where: { id }, data: { status: 'audit_reviewed' } });

  return NextResponse.json({ auditReview: updatedReview, application: updatedApplication });
}
