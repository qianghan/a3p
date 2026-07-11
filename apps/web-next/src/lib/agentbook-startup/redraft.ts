import { prisma } from '@naap/database';
import { getJurisdictionPack } from '@agentbook/jurisdictions';
import '@/lib/agentbook-startup/discovery'; // side effect: loadBuiltInPacks() — see PR #207

export async function redraftApplication(applicationId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const application = await prisma.startupBenefitApplication.findUnique({ where: { id: applicationId } });
  if (!application) return { status: 404, body: { error: 'not found' } };

  const [program, profile, documents, decisionPoints] = await Promise.all([
    prisma.startupBenefitProgram.findUnique({ where: { id: application.programId } }),
    prisma.startupBenefitProfile.findUnique({ where: { tenantId: application.tenantId } }),
    prisma.startupBenefitDocument.findMany({ where: { applicationId } }),
    prisma.startupBenefitDecisionPoint.findMany({ where: { applicationId } }),
  ]);
  if (!program) return { status: 404, body: { error: 'program not found' } };

  const taxBenefits = getJurisdictionPack(program.jurisdiction)?.taxBenefits;
  if (!taxBenefits) return { status: 400, body: { error: 'jurisdiction not supported' } };

  const documentsByType: Record<string, unknown> = {};
  for (const doc of documents) {
    documentsByType[doc.docType] = { ...(doc.extractedData as object ?? {}), _id: doc.id };
  }
  const answers: Record<string, unknown> = {};
  for (const dp of decisionPoints) {
    if (dp.response != null) answers[String(dp.sequenceOrder)] = dp.response;
  }

  const draft = taxBenefits.draftApplication(program.programCode, {
    profile: {
      companyType: profile?.companyType ?? undefined,
      incorporatedAt: profile?.incorporatedAt ?? undefined,
      headcount: profile?.headcount ?? undefined,
      annualRdSpendCents: profile?.annualRdSpendCents ?? undefined,
      equityRaisedCents: profile?.equityRaisedCents ?? undefined,
    },
    documents: documentsByType,
    answers,
  });

  const expectedPoints = taxBenefits.getDecisionPoints(program.programCode, draft);
  const existingOrders = new Set(decisionPoints.map((dp) => dp.sequenceOrder));
  const newPoints = expectedPoints.filter((p) => !existingOrders.has(p.sequenceOrder));
  if (newPoints.length > 0) {
    // skipDuplicates backstops the read-then-write race above (e.g. two
    // near-simultaneous redraft calls both computing the same "missing"
    // sequenceOrder) — relies on the @@unique([applicationId, sequenceOrder])
    // constraint on this model to actually detect the conflict.
    await prisma.startupBenefitDecisionPoint.createMany({
      data: newPoints.map((p) => ({
        applicationId, sequenceOrder: p.sequenceOrder, kind: p.kind, prompt: p.prompt,
        options: p.options ?? undefined, blocksProgress: true,
      })),
      skipDuplicates: true,
    });
  }

  const finalDecisionPoints = await prisma.startupBenefitDecisionPoint.findMany({ where: { applicationId }, orderBy: { sequenceOrder: 'asc' } });
  const hasUnansweredBlocking = finalDecisionPoints.some((dp) => dp.blocksProgress && dp.response == null);
  const status = draft.completeness >= 1 && !hasUnansweredBlocking ? 'ready_for_review'
    : hasUnansweredBlocking ? 'decision_pending'
    : 'drafting';

  const updated = await prisma.startupBenefitApplication.update({
    where: { id: applicationId },
    data: { draft: draft as object, status },
  });

  return { status: 200, body: { application: updated, decisionPoints: finalDecisionPoints } };
}
