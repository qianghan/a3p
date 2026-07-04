import { prisma } from '@naap/database';
import { getJurisdictionPack, AUDIT_REVIEW_MODEL_VERSION, type DraftResult } from '@agentbook/jurisdictions';
import '@/lib/agentbook-startup/discovery'; // side effect: loadBuiltInPacks() — see PR #207

export async function runAuditReview(applicationId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const application = await prisma.startupBenefitApplication.findUnique({ where: { id: applicationId } });
  if (!application) return { status: 404, body: { error: 'not found' } };

  const program = await prisma.startupBenefitProgram.findUnique({ where: { id: application.programId } });
  if (!program) return { status: 404, body: { error: 'program not found' } };

  const taxBenefits = getJurisdictionPack(program.jurisdiction)?.taxBenefits;
  if (!taxBenefits) return { status: 400, body: { error: 'jurisdiction not supported' } };

  const draft = application.draft as unknown as DraftResult | null;
  if (draft?.completeness == null) {
    return { status: 400, body: { error: 'draft is not ready for audit review yet' } };
  }

  const assessment = taxBenefits.assessAuditRisk(program.programCode, draft);

  const auditReview = await prisma.startupBenefitAuditReview.upsert({
    where: { applicationId },
    create: {
      applicationId,
      riskLevel: assessment.riskLevel,
      findings: assessment.findings as object,
      modelVersion: AUDIT_REVIEW_MODEL_VERSION,
      overrides: [],
    },
    update: {
      riskLevel: assessment.riskLevel,
      findings: assessment.findings as object,
      modelVersion: AUDIT_REVIEW_MODEL_VERSION,
      overrides: [],
      reviewedAt: new Date(),
    },
  });

  const hasBlockingHighSeverity = assessment.findings.some((f) => f.severity === 'high');
  const status = hasBlockingHighSeverity ? 'ready_for_review' : 'audit_reviewed';
  const updated = await prisma.startupBenefitApplication.update({
    where: { id: applicationId },
    data: { auditRiskLevel: assessment.riskLevel, status },
  });

  return { status: 200, body: { application: updated, auditReview } };
}
