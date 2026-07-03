import 'server-only';
import { prisma } from '@naap/database';
import type Stripe from 'stripe';
import { maskEmail } from './referrals';

export type PayoutFrequency = 'monthly' | 'quarterly' | 'annual';

/**
 * Money-moving actions (submitting an invoice, changing where payment goes)
 * require the rep still be active — a removed rep keeps read access to their
 * own history (getSalesRepSummary), but can't submit new claims or redirect
 * where an already-submitted invoice gets paid.
 */
export async function requireActiveSalesRep(tenantId: string) {
  const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId } });
  if (!profile || profile.status !== 'active') {
    throw new Error('Not an active sales rep.');
  }
  return profile;
}

/**
 * Sales rep commission accrual — see docs/plans (jolly-wondering-engelbart)
 * for the full design. Sibling to referrals.ts, but fires on EVERY recurring
 * payment (unlike processInviteePaid, which is first-payment-only), since
 * a rep earns commission on the ongoing subscription revenue they generate,
 * not a one-time reward.
 */

/**
 * Called from the Stripe webhook's invoice.paid handler for every paying
 * account. No-op unless that account's referral was attributed to a
 * sales-rep-owned code (BillReferralCode.salesRepId set) — ordinary peer
 * referrals are untouched by this function entirely.
 *
 * Idempotent via the SalesRepCommissionAccrual @@unique([salesRepId, stripeEventId])
 * constraint — a Stripe webhook retry hitting this twice throws on the
 * unique violation, which the caller catches and ignores (matching the
 * existing BillEvent.stripeEventId idempotency idiom in route.ts).
 */
export async function accrueSalesRepCommission(
  inviteeTenantId: string,
  invoice: Stripe.Invoice,
  stripeEventId: string,
): Promise<void> {
  const referral = await prisma.billReferral.findUnique({ where: { inviteeTenantId } });
  if (!referral) return; // not a referred signup at all

  const referralCode = await prisma.billReferralCode.findFirst({ where: { code: referral.code } });
  if (!referralCode?.salesRepId) return; // ordinary peer referral, not a rep's

  const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId: referralCode.salesRepId } });
  if (!profile || profile.status !== 'active') return; // removed/suspended reps stop accruing

  const revenueCents = invoice.amount_paid;
  if (!revenueCents || revenueCents <= 0) return; // $0 invoice (e.g. fully covered by credit) — nothing to commission

  const commissionCents = Math.round((revenueCents * profile.commissionBps) / 10000);

  const invoiceData = invoice as unknown as { period_start: number; period_end: number };
  const periodStart = new Date((invoiceData.period_start ?? Math.floor(Date.now() / 1000)) * 1000);
  const periodEnd = new Date((invoiceData.period_end ?? Math.floor(Date.now() / 1000)) * 1000);

  try {
    await prisma.salesRepCommissionAccrual.create({
      data: {
        salesRepId: referralCode.salesRepId,
        inviteeTenantId,
        billReferralId: referral.id,
        stripeEventId,
        revenueCents,
        commissionBpsUsed: profile.commissionBps,
        commissionCents,
        periodStart,
        periodEnd,
      },
    });
  } catch (err) {
    // Unique violation on [salesRepId, stripeEventId] = already accrued for
    // this event (webhook retry). Anything else is a real failure.
    const isDuplicate = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002';
    if (!isDuplicate) throw err;
  }
}

/** Calendar period containing `date`, per the given payout cadence. */
function periodBounds(frequency: PayoutFrequency, date: Date): { start: Date; end: Date } {
  const y = date.getUTCFullYear();
  if (frequency === 'annual') {
    return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
  if (frequency === 'quarterly') {
    const qStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    return { start: new Date(Date.UTC(y, qStartMonth, 1)), end: new Date(Date.UTC(y, qStartMonth + 3, 1)) };
  }
  const m = date.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** The most recently fully-elapsed period as of now — the one a rep can submit an invoice for. */
function closedPeriod(frequency: PayoutFrequency, now: Date): { start: Date; end: Date } {
  const current = periodBounds(frequency, now);
  // One millisecond before the current period's start is guaranteed to fall in the prior period.
  return periodBounds(frequency, new Date(current.start.getTime() - 1));
}

export type PayoutMethodStatus = 'not_started' | 'pending' | 'active';

export function connectStatus(profile: { stripeConnectAccountId: string | null; stripeConnectPayoutsEnabled: boolean }): PayoutMethodStatus {
  if (profile.stripeConnectPayoutsEnabled) return 'active';
  if (profile.stripeConnectAccountId) return 'pending';
  return 'not_started';
}

export interface SalesRepSummary {
  profile: {
    commissionBps: number;
    payoutFrequency: PayoutFrequency;
    status: string;
    payoutStatus: PayoutMethodStatus;
    referralCode: string | null;
  };
  invitees: Array<{ maskedEmail: string | null; status: string; joinedAt: string; paidAt: string | null; commissionCents: number }>;
  revenue: { thisMonthCents: number; thisYearCents: number; allTimeCents: number };
  pendingCommissionCents: number; // accrued, not yet bundled into a payout
}

/** Full self-serve summary for the sales rep dashboard. */
export async function getSalesRepSummary(tenantId: string): Promise<SalesRepSummary> {
  const profile = await prisma.salesRepProfile.findUniqueOrThrow({ where: { tenantId } });
  const referralCode = await prisma.billReferralCode.findFirst({ where: { salesRepId: tenantId } });
  const referrals = await prisma.billReferral.findMany({
    where: { referrerTenantId: tenantId },
    orderBy: { joinedAt: 'desc' },
  });
  const accruals = await prisma.salesRepCommissionAccrual.findMany({ where: { salesRepId: tenantId, reversedAt: null } });

  const commissionByInvitee = new Map<string, number>();
  for (const a of accruals) {
    commissionByInvitee.set(a.inviteeTenantId, (commissionByInvitee.get(a.inviteeTenantId) ?? 0) + a.commissionCents);
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  let thisMonthCents = 0;
  let thisYearCents = 0;
  let allTimeCents = 0;
  for (const a of accruals) {
    allTimeCents += a.commissionCents;
    if (a.createdAt >= yearStart) thisYearCents += a.commissionCents;
    if (a.createdAt >= monthStart) thisMonthCents += a.commissionCents;
  }
  const pendingCommissionCents = accruals.filter((a) => !a.payoutId).reduce((s, a) => s + a.commissionCents, 0);

  return {
    profile: {
      commissionBps: profile.commissionBps,
      payoutFrequency: profile.payoutFrequency as PayoutFrequency,
      status: profile.status,
      payoutStatus: connectStatus(profile),
      referralCode: referralCode?.code ?? null,
    },
    invitees: referrals.map((r) => ({
      maskedEmail: maskEmail(r.inviteeEmail),
      status: r.status,
      joinedAt: r.joinedAt.toISOString(),
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      commissionCents: commissionByInvitee.get(r.inviteeTenantId) ?? 0,
    })),
    revenue: { thisMonthCents, thisYearCents, allTimeCents },
    pendingCommissionCents,
  };
}

export async function listSalesRepPayouts(tenantId: string) {
  return prisma.salesRepPayout.findMany({ where: { salesRepId: tenantId }, orderBy: { submittedAt: 'desc' } });
}

/**
 * Submit one commission invoice for the most recently closed payout period.
 * Bundles every un-bundled, non-reversed accrual up through that period's
 * end (so any older stragglers get swept in too) — throws a descriptive
 * error rather than silently no-op'ing on invalid states, since this is a
 * money-moving action the caller must surface to the rep.
 */
export async function submitSalesRepPayout(tenantId: string): Promise<{ id: string; invoiceNumber: string; totalCents: number }> {
  const profile = await requireActiveSalesRep(tenantId);
  const period = closedPeriod(profile.payoutFrequency as PayoutFrequency, new Date());

  const alreadySubmitted = await prisma.salesRepPayout.findFirst({
    where: { salesRepId: tenantId, periodStart: period.start, periodEnd: period.end },
  });
  if (alreadySubmitted) {
    throw new Error(`Already submitted an invoice for this ${profile.payoutFrequency} period.`);
  }

  const bundle = await prisma.salesRepCommissionAccrual.findMany({
    where: { salesRepId: tenantId, payoutId: null, reversedAt: null, periodEnd: { lte: period.end } },
  });
  if (bundle.length === 0) {
    throw new Error('No commission accrued yet for this period.');
  }
  const totalCents = bundle.reduce((s, a) => s + a.commissionCents, 0);

  const year = new Date().getUTCFullYear();
  const countThisYear = await prisma.salesRepPayout.count({
    where: { submittedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
  });
  const invoiceNumber = `COMM-${year}-${String(countThisYear + 1).padStart(4, '0')}`;

  try {
    const payout = await prisma.$transaction(async (tx) => {
      // The unique constraint on [salesRepId, periodStart, periodEnd] is the
      // real guard — the findFirst check above is just a fast, friendly
      // pre-check for the common (non-racing) case.
      const created = await tx.salesRepPayout.create({
        data: {
          salesRepId: tenantId,
          invoiceNumber,
          periodLabel: `${period.start.toISOString().slice(0, 10)} to ${period.end.toISOString().slice(0, 10)}`,
          periodStart: period.start,
          periodEnd: period.end,
          totalCents,
        },
      });
      await tx.salesRepCommissionAccrual.updateMany({
        where: { id: { in: bundle.map((a) => a.id) } },
        data: { payoutId: created.id },
      });
      return created;
    });

    return { id: payout.id, invoiceNumber: payout.invoiceNumber, totalCents: payout.totalCents };
  } catch (err) {
    const isDuplicatePeriod = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002';
    if (isDuplicatePeriod) {
      throw new Error(`Already submitted an invoice for this ${profile.payoutFrequency} period.`);
    }
    throw err;
  }
}

