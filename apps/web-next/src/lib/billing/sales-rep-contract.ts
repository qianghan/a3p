import 'server-only';
import { prisma, Prisma } from '@naap/database';
import { checkPartnerEligibility, withLockedDraftApplication } from './sales-rep-application';
import { LIABILITY_SECTION_KEYS, type LiabilitySectionKey } from './sales-rep-contract-templates';

/**
 * Platform default commission rate assumed in the self-serve contract a
 * Partner Program applicant signs — see sales-rep.html §3: the rebate math
 * is derived from, and this codebase's admin-promotion default has always
 * been, a 20% commission rate. Admin can still set a different per-rep rate
 * at promotion time for the admin-direct-invite path (§7/§11 item 3), but a
 * self-serve applicant signs at this rate — it's frozen into their contract
 * via SalesRepContract.commissionBpsAtSigning, not re-negotiated later.
 */
export const DEFAULT_COMMISSION_BPS = 2000;

/**
 * Governing-law state named in the US contract shell (§16, clause 11). A
 * platform-side agreement naming its own state, not the counterparty's
 * residence, is the standard pattern — this is a placeholder pending real
 * legal sign-off (see the seed script's legallyReviewed: false), not a
 * jurisdiction the Representative is asked to declare.
 */
const PLATFORM_GOVERNING_STATE = 'Delaware';

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`);
}

async function buildContractVariables(application: {
  jurisdiction: string;
  annualFeeCentsPaid: number;
}) {
  const settings = await prisma.partnerProgramSettings.findUnique({ where: { id: 'singleton' } });
  const rebateCommissionMultiple = settings?.rebateCommissionMultiple ?? 1.0;

  return {
    commissionBps: String(DEFAULT_COMMISSION_BPS),
    commissionPercent: String(DEFAULT_COMMISSION_BPS / 100),
    payoutFrequency: 'quarterly',
    rebateCommissionMultiple: String(rebateCommissionMultiple),
    annualFeeFormatted: formatCents(application.annualFeeCentsPaid),
    governingState: PLATFORM_GOVERNING_STATE,
  };
}

export interface LiabilitySectionView {
  key: LiabilitySectionKey;
  title: string;
  body: string;
  acknowledged: boolean;
}

/**
 * Everything step 3-5 of the application UI needs to render: the per-section
 * disclosures (personalized with this applicant's numbers) plus which ones
 * they've already acknowledged, and — once all required acks are in place —
 * the full assembled agreement text for the step-5 final read.
 */
export async function getApplicationContractPreview(tenantId: string, applicationId: string) {
  const application = await prisma.salesRepApplication.findUnique({ where: { id: applicationId } });
  if (!application || application.tenantId !== tenantId) {
    throw new Error('Application not found.');
  }

  const template = await prisma.salesRepContractTemplate.findUnique({
    where: { jurisdiction: application.jurisdiction },
  });
  if (!template) {
    throw new Error(
      `The Partner Program isn't available yet for jurisdiction "${application.jurisdiction}" — no contract template is on file. Contact support.`,
    );
  }

  const vars = await buildContractVariables(application);
  const answers = (application.answers ?? {}) as Record<string, unknown>;
  const acknowledgedSections = new Set(
    Array.isArray(answers.acknowledgedSections) ? (answers.acknowledgedSections as string[]) : [],
  );

  const liabilityClauses = template.liabilityClauses as Record<
    LiabilitySectionKey,
    { title: string; body: string }
  >;
  const sections: LiabilitySectionView[] = LIABILITY_SECTION_KEYS.map((key) => ({
    key,
    title: liabilityClauses[key].title,
    body: renderTemplate(liabilityClauses[key].body, vars),
    acknowledged: acknowledgedSections.has(key),
  }));

  const allSectionsAcknowledged = sections.every((s) => s.acknowledged);
  const taxpayerNoticeAcknowledged = answers.taxpayerNoticeAcknowledged === true;

  return {
    jurisdiction: application.jurisdiction,
    taxFormType: template.taxFormType,
    sections,
    allSectionsAcknowledged,
    taxpayerNoticeAcknowledged,
    readyToSign: allSectionsAcknowledged && taxpayerNoticeAcknowledged,
    contractPreviewHtml: renderTemplate(template.bodyTemplate, {
      ...vars,
      legalName: '{{legalName — filled in at signing}}',
      signedByName: '{{signedByName — filled in at signing}}',
      signedAt: '{{signedAt — filled in at signing}}',
    }),
  };
}

/**
 * Records or clears acknowledgment of one liability section (step 3), or
 * the taxpayer-information notice (step 4). Stored inline in
 * SalesRepApplication.answers rather than a new table — these are draft-only
 * flags, superseded entirely by the frozen SalesRepContract once signed.
 */
export async function setApplicationAcknowledgment(
  tenantId: string,
  applicationId: string,
  input: { sectionKey?: LiabilitySectionKey; taxpayerNotice?: boolean },
  acknowledged: boolean,
) {
  return withLockedDraftApplication(tenantId, applicationId, (application) => {
    const answers = { ...(application.answers as Record<string, unknown>) };
    if (input.sectionKey) {
      if (!LIABILITY_SECTION_KEYS.includes(input.sectionKey)) {
        throw new Error(`Unknown disclosure section: ${input.sectionKey}`);
      }
      const current = new Set(
        Array.isArray(answers.acknowledgedSections) ? (answers.acknowledgedSections as string[]) : [],
      );
      if (acknowledged) current.add(input.sectionKey);
      else current.delete(input.sectionKey);
      answers.acknowledgedSections = Array.from(current);
    }
    if (input.taxpayerNotice !== undefined) {
      answers.taxpayerNoticeAcknowledged = acknowledged;
    }
    return { answers: answers as Prisma.InputJsonValue };
  });
}

/**
 * Step 5: e-sign and submit. Clickwrap-style signature (typed legal name +
 * explicit agreement + captured timestamp/IP/user-agent) — see sales-rep.html
 * §10 for why nothing heavier is needed at this stage. Re-checks eligibility
 * and re-snapshots the plan/fee at submit time rather than trusting the
 * draft-start snapshot, since a draft can sit unfinished for a while.
 */
export async function signAndSubmitApplication(
  tenantId: string,
  applicationId: string,
  input: { signedByName: string; signerIp: string; signerUserAgent: string },
) {
  const signedByName = input.signedByName.trim();
  if (!signedByName) {
    throw new Error('Type your full legal name to sign.');
  }

  const application = await prisma.salesRepApplication.findUnique({ where: { id: applicationId } });
  if (!application || application.tenantId !== tenantId) {
    throw new Error('Application not found.');
  }
  if (application.status !== 'draft') {
    throw new Error('This application has already been submitted.');
  }

  const eligibility = await checkPartnerEligibility(tenantId);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }

  const user = await prisma.user.findUnique({ where: { id: tenantId }, select: { displayName: true } });
  if (user?.displayName) {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalize(signedByName) !== normalize(user.displayName)) {
      throw new Error(`The typed name must match the name on your account ("${user.displayName}").`);
    }
  }

  const preview = await getApplicationContractPreview(tenantId, applicationId);
  if (!preview.readyToSign) {
    throw new Error('You must acknowledge every disclosure section and the taxpayer notice before signing.');
  }

  const template = await prisma.salesRepContractTemplate.findUnique({
    where: { jurisdiction: application.jurisdiction },
  });
  if (!template) {
    throw new Error(
      `The Partner Program isn't available yet for jurisdiction "${application.jurisdiction}" — no contract template is on file. Contact support.`,
    );
  }

  const sub = await prisma.billSubscription.findUniqueOrThrow({
    where: { accountId: tenantId },
    include: { plan: true },
  });
  const vars = await buildContractVariables(application);
  const signedAt = new Date();
  const renderedHtml = renderTemplate(template.bodyTemplate, {
    ...vars,
    legalName: signedByName,
    signedByName,
    signedAt: signedAt.toISOString().slice(0, 10),
  });

  const [, contract] = await prisma.$transaction([
    prisma.salesRepApplication.update({
      where: { id: applicationId },
      data: {
        status: 'submitted',
        submittedAt: signedAt,
        eligibilityPlanCode: sub.plan.code,
        eligibilityInterval: sub.plan.interval,
        annualFeeCentsPaid: sub.plan.priceCents,
      },
    }),
    prisma.salesRepContract.create({
      data: {
        applicationId,
        templateVersion: template.version,
        renderedHtml,
        signedByName,
        signedAt,
        signerIp: input.signerIp,
        signerUserAgent: input.signerUserAgent,
        commissionBpsAtSigning: DEFAULT_COMMISSION_BPS,
      },
    }),
  ]);

  return {
    application: await prisma.salesRepApplication.findUniqueOrThrow({ where: { id: applicationId } }),
    contract,
  };
}
