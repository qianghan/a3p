import 'server-only';
import { prisma, Prisma } from '@naap/database';

const REAPPLY_COOLDOWN_DAYS = 90;

export type EligibilityResult = { eligible: true } | { eligible: false; reason: string };

/**
 * Eligibility to APPLY for the Partner Program: an active, genuinely paid
 * (not comped/manual), annual-billing subscription on a non-free plan.
 * This is the anti-abuse gate — see sales-rep.html §3. Being an already-
 * approved sales rep does not exempt a tenant from this check on a NEW
 * application; only the retained admin-direct-invite path (§7, §11 item 3)
 * bypasses it, and that path never calls this function.
 */
export async function checkPartnerEligibility(tenantId: string): Promise<EligibilityResult> {
  // Covers reps promoted via the admin-direct-invite path (§7, §11 item 3),
  // who have a SalesRepProfile but no SalesRepApplication row at all —
  // without this check, startOrResumeApplication's "already have a
  // non-terminal/approved application" guard below would never see them
  // and would let an already-active rep start a redundant new application.
  const existingProfile = await prisma.salesRepProfile.findUnique({ where: { tenantId } });
  if (existingProfile && existingProfile.status === 'active') {
    return { eligible: false, reason: 'You are already an active partner.' };
  }

  const sub = await prisma.billSubscription.findUnique({
    where: { accountId: tenantId },
    include: { plan: true },
  });

  if (!sub || sub.status !== 'active') {
    return { eligible: false, reason: 'You need an active subscription to apply.' };
  }
  if (sub.plan.code === 'free') {
    return { eligible: false, reason: 'The Partner Program requires a paid plan — you are currently on Free.' };
  }
  if (sub.plan.interval !== 'year') {
    return { eligible: false, reason: 'The Partner Program requires annual billing — switch from monthly to annual to apply.' };
  }
  if (sub.billingSource !== 'stripe') {
    return { eligible: false, reason: 'Your plan needs to be a genuinely paid subscription, not a comped one, to apply.' };
  }
  return { eligible: true };
}

/**
 * Row-locks a draft application and runs `mutate` against it inside the
 * same transaction, then persists the result. Both saveApplicationDraft and
 * setApplicationAcknowledgment merge into the same JSON `answers` field —
 * without a lock, two near-simultaneous requests (rapid checkbox clicks
 * before the first PATCH's disabled-state re-render commits, a flaky
 * retry, two tabs) each read the pre-write value and the second write
 * silently clobbers the first (a classic lost-update race). `FOR UPDATE`
 * makes the second transaction wait for the first to commit, so it reads
 * the already-merged value rather than the stale one.
 */
export async function withLockedDraftApplication(
  tenantId: string,
  applicationId: string,
  mutate: (application: { answers: unknown; jurisdiction: string }) => Prisma.SalesRepApplicationUpdateInput,
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; status: string; answers: unknown; jurisdiction: string }>>`
      SELECT id, "tenantId", status, answers, jurisdiction
      FROM "plugin_agentbook_billing"."SalesRepApplication"
      WHERE id = ${applicationId}
      FOR UPDATE
    `;
    const application = rows[0];
    if (!application || application.tenantId !== tenantId) {
      throw new Error('Application not found.');
    }
    if (application.status !== 'draft') {
      throw new Error('This application has already been submitted and can no longer be edited here.');
    }

    const data = mutate(application);
    return tx.salesRepApplication.update({ where: { id: applicationId }, data });
  });
}

export async function getLatestApplication(tenantId: string) {
  return prisma.salesRepApplication.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Starts a new draft application, or resumes an existing one still in
 * draft. Throws (with a user-facing message) if the applicant is
 * ineligible, mid-cooldown after a rejection, or already has a
 * non-terminal application — only one active application per tenant.
 *
 * annualFeeCentsPaid/eligibilityPlanCode/eligibilityInterval are snapshotted
 * here as a starting value for the draft; submission (a later PR) re-checks
 * eligibility and re-snapshots them, since a draft can sit unfinished for
 * a while and the binding snapshot should reflect what was true at submit
 * time, not draft-start time.
 */
export async function startOrResumeApplication(tenantId: string) {
  const eligibility = await checkPartnerEligibility(tenantId);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }

  const latest = await getLatestApplication(tenantId);
  if (latest) {
    if (latest.status === 'draft') return latest;
    if (latest.status === 'submitted' || latest.status === 'under_review' || latest.status === 'more_info_requested') {
      throw new Error('You already have an application in progress.');
    }
    if (latest.status === 'approved') {
      throw new Error('You are already an approved partner.');
    }
    if (latest.status === 'rejected' && latest.reviewedAt) {
      const cooldownEnds = new Date(latest.reviewedAt.getTime() + REAPPLY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      if (cooldownEnds > new Date()) {
        throw new Error(`You can reapply after ${cooldownEnds.toISOString().slice(0, 10)}.`);
      }
    }
  }

  const sub = await prisma.billSubscription.findUniqueOrThrow({
    where: { accountId: tenantId },
    include: { plan: true },
  });
  const tenantConfig = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });

  return prisma.salesRepApplication.create({
    data: {
      tenantId,
      status: 'draft',
      jurisdiction: tenantConfig?.jurisdiction ?? 'us',
      answers: {},
      eligibilityPlanCode: sub.plan.code,
      eligibilityInterval: sub.plan.interval,
      annualFeeCentsPaid: sub.plan.priceCents,
    },
  });
}

/**
 * Saves progress on a draft application (steps 1-2: fit-question answers +
 * jurisdiction confirmation). Merges into the existing answers object
 * rather than replacing it, so steps can be saved independently.
 */
export async function saveApplicationDraft(
  tenantId: string,
  applicationId: string,
  updates: { answers?: Record<string, unknown>; jurisdiction?: string },
) {
  return withLockedDraftApplication(tenantId, applicationId, (application) => {
    const data: Prisma.SalesRepApplicationUpdateInput = {};
    if (updates.answers) {
      data.answers = { ...(application.answers as Record<string, unknown>), ...updates.answers } as Prisma.InputJsonValue;
    }
    if (updates.jurisdiction) {
      data.jurisdiction = updates.jurisdiction;
    }
    return data;
  });
}
