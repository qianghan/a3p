import 'server-only';
import { prisma } from '@/lib/db';
import { invalidateAccount } from '@naap/billing';
import { getOrCreateReferralCode } from '@/lib/billing/referrals';
import { createNotification } from '@/lib/notifications';

/**
 * Admin review pipeline for self-serve sales-rep applications.
 *
 * The apply flow (sales-rep-application.ts / sales-rep-contract.ts) moves an
 * application draft → submitted and freezes a signed SalesRepContract, but
 * nothing converted a submitted application into an active rep. This closes
 * that gap: an admin approves/rejects/requests-info, and approval provisions
 * the rep — reusing the same profile+role+referral-code wiring as the
 * direct-invite route (admin/users/[id]/sales-rep), EXCEPT it does NOT comp a
 * plan: an approved applicant is already on their own paid annual plan
 * (enforced at submit), so we keep their real subscription.
 */

const SALES_REP_ROLE = 'sales_rep';
const REVIEWABLE_STATUSES = ['submitted', 'under_review', 'more_info_requested'] as const;

export class ApplicationReviewError extends Error {}

export interface ApplicationListItem {
  id: string;
  tenantId: string;
  status: string;
  jurisdiction: string;
  eligibilityPlanCode: string;
  annualFeeCentsPaid: number;
  submittedAt: string | null;
  createdAt: string;
  aiRiskLevel: string | null;
  aiRecommendation: string | null;
  user: { email: string | null; displayName: string | null };
  signedCommissionBps: number | null;
}

/** Applications an admin should act on (submitted/under_review/more_info) + recently decided, newest first. */
export async function listApplicationsForReview(opts?: { includeDecided?: boolean }): Promise<ApplicationListItem[]> {
  const statuses = opts?.includeDecided
    ? [...REVIEWABLE_STATUSES, 'approved', 'rejected']
    : [...REVIEWABLE_STATUSES];

  const apps = await prisma.salesRepApplication.findMany({
    where: { status: { in: statuses } },
    orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });

  const tenantIds = apps.map((a) => a.tenantId);
  const [users, contracts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: tenantIds } }, select: { id: true, email: true, displayName: true } }),
    prisma.salesRepContract.findMany({ where: { applicationId: { in: apps.map((a) => a.id) } }, select: { applicationId: true, commissionBpsAtSigning: true } }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const bpsByApp = new Map(contracts.map((c) => [c.applicationId, c.commissionBpsAtSigning]));

  return apps.map((a) => ({
    id: a.id,
    tenantId: a.tenantId,
    status: a.status,
    jurisdiction: a.jurisdiction,
    eligibilityPlanCode: a.eligibilityPlanCode,
    annualFeeCentsPaid: a.annualFeeCentsPaid,
    submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    aiRiskLevel: a.aiRiskLevel,
    aiRecommendation: a.aiRecommendation,
    user: { email: userById.get(a.tenantId)?.email ?? null, displayName: userById.get(a.tenantId)?.displayName ?? null },
    signedCommissionBps: bpsByApp.get(a.id) ?? null,
  }));
}

/** Full application detail for the review drawer (answers + signed contract + user). */
export async function getApplicationForReview(id: string) {
  const app = await prisma.salesRepApplication.findUnique({ where: { id } });
  if (!app) throw new ApplicationReviewError('Application not found.');
  const [user, contract] = await Promise.all([
    prisma.user.findUnique({ where: { id: app.tenantId }, select: { email: true, displayName: true } }),
    prisma.salesRepContract.findUnique({ where: { applicationId: id }, select: { commissionBpsAtSigning: true, signedByName: true, signedAt: true, templateVersion: true } }),
  ]);
  return { ...app, user, contract };
}

function assertReviewable(status: string) {
  if (!REVIEWABLE_STATUSES.includes(status as (typeof REVIEWABLE_STATUSES)[number])) {
    throw new ApplicationReviewError(`Application is '${status}' — only submitted/under_review/more_info applications can be decided.`);
  }
}

/**
 * Approve an application and provision the rep. commissionBps defaults to the
 * rate the applicant actually signed (contract.commissionBpsAtSigning); an
 * admin may override at approval. Keeps the applicant's own paid subscription
 * (billingSource carried from their existing row). Idempotent-ish: a second
 * approve on an already-approved app throws (use the rep tools to edit).
 */
export async function approveApplication(
  id: string,
  adminId: string,
  opts?: { commissionBps?: number; payoutFrequency?: 'monthly' | 'quarterly' | 'annual'; notes?: string },
): Promise<{ tenantId: string; commissionBps: number; referralCode: string }> {
  const app = await prisma.salesRepApplication.findUnique({ where: { id } });
  if (!app) throw new ApplicationReviewError('Application not found.');
  assertReviewable(app.status);

  const contract = await prisma.salesRepContract.findUnique({ where: { applicationId: id }, select: { commissionBpsAtSigning: true } });
  const commissionBps = opts?.commissionBps ?? contract?.commissionBpsAtSigning ?? 2000;
  if (!Number.isInteger(commissionBps) || commissionBps <= 0 || commissionBps > 10000) {
    throw new ApplicationReviewError('commissionBps must be an integer 1–10000 (e.g. 2000 = 20%).');
  }
  const payoutFrequency = opts?.payoutFrequency ?? 'quarterly';

  const role = await prisma.role.findUnique({ where: { name: SALES_REP_ROLE }, select: { id: true } });
  if (!role) throw new ApplicationReviewError('sales_rep role is not provisioned — run bin/seed-agentbook-defaults.ts');

  // An approved applicant already pays for their own plan; carry that source.
  const sub = await prisma.billSubscription.findUnique({ where: { accountId: app.tenantId }, select: { billingSource: true } });
  const billingSource = sub?.billingSource ?? 'stripe';

  await prisma.$transaction(async (tx) => {
    await tx.userRole.upsert({
      where: { userId_roleId: { userId: app.tenantId, roleId: role.id } },
      update: {},
      create: { userId: app.tenantId, roleId: role.id, grantedBy: adminId },
    });
    await tx.salesRepProfile.upsert({
      where: { tenantId: app.tenantId },
      create: { tenantId: app.tenantId, commissionBps, payoutFrequency, billingSource, promotedBy: adminId },
      update: { status: 'active', commissionBps, payoutFrequency, removedAt: null, removedBy: null },
    });
    await tx.salesRepApplication.update({
      where: { id },
      data: { status: 'approved', reviewDecision: 'approve', reviewedBy: adminId, reviewedAt: new Date(), reviewNotes: opts?.notes ?? null },
    });
  });

  // Outside the txn (own retry loop; a rep without a code yet is recoverable).
  const code = await getOrCreateReferralCode(app.tenantId);
  await prisma.billReferralCode.update({ where: { code }, data: { salesRepId: app.tenantId } });
  invalidateAccount(app.tenantId);

  await createNotification({
    category: 'admin_broadcast',
    title: 'You’re approved as an AgentBook partner 🎉',
    body: 'Your partner application is approved. Set up your payouts and grab your referral link from your sales-rep dashboard to start earning.',
    ctaLabel: 'Open partner dashboard',
    ctaUrl: '/sales-rep',
    createdByType: 'system',
    audienceType: 'single',
    audienceFilter: { tenantId: app.tenantId },
  }).catch((e) => console.error('[approveApplication] notify failed:', e));

  return { tenantId: app.tenantId, commissionBps, referralCode: code };
}

/** Reject an application (applicant may re-apply after the 90-day cooldown). */
export async function rejectApplication(id: string, adminId: string, reason: string): Promise<{ tenantId: string }> {
  const app = await prisma.salesRepApplication.findUnique({ where: { id } });
  if (!app) throw new ApplicationReviewError('Application not found.');
  assertReviewable(app.status);
  if (!reason?.trim()) throw new ApplicationReviewError('A rejection reason is required.');

  await prisma.salesRepApplication.update({
    where: { id },
    data: { status: 'rejected', reviewDecision: 'reject', reviewedBy: adminId, reviewedAt: new Date(), reviewNotes: reason.trim() },
  });

  await createNotification({
    category: 'admin_broadcast',
    title: 'Update on your partner application',
    body: 'Thanks for applying to the AgentBook partner program. We’re not able to approve your application right now — you’re welcome to re-apply after 90 days.',
    createdByType: 'system',
    audienceType: 'single',
    audienceFilter: { tenantId: app.tenantId },
  }).catch((e) => console.error('[rejectApplication] notify failed:', e));

  return { tenantId: app.tenantId };
}

/** Ask the applicant for more information (keeps the application open). */
export async function requestMoreInfo(id: string, adminId: string, message: string): Promise<{ tenantId: string }> {
  const app = await prisma.salesRepApplication.findUnique({ where: { id } });
  if (!app) throw new ApplicationReviewError('Application not found.');
  assertReviewable(app.status);
  if (!message?.trim()) throw new ApplicationReviewError('A message to the applicant is required.');

  await prisma.salesRepApplication.update({
    where: { id },
    data: {
      status: 'more_info_requested',
      reviewDecision: 'more_info',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      moreInfoRequestedAt: new Date(),
      moreInfoMessage: message.trim(),
    },
  });

  await createNotification({
    category: 'admin_broadcast',
    title: 'We need a bit more info on your partner application',
    body: message.trim(),
    ctaLabel: 'View application',
    ctaUrl: '/sales-rep/apply',
    createdByType: 'system',
    audienceType: 'single',
    audienceFilter: { tenantId: app.tenantId },
  }).catch((e) => console.error('[requestMoreInfo] notify failed:', e));

  return { tenantId: app.tenantId };
}
