import 'server-only';
import crypto from 'crypto';
import { prisma } from '@naap/database';
import { getStripe } from './stripe';
import { createNotification } from '../notifications';

/**
 * Referral program core.
 *
 * Model: one code per tenant (referrer). An invitee who signs up via the code
 * and then pays earns the referrer 1 free month, capped at 12 (1 year). The
 * reward is applied as a Stripe customer-balance credit of one month's price;
 * if the referrer isn't a paying customer yet, the reward is "banked" (the
 * BillReferral row is marked rewardMonths=1 with creditedAt=null) and flushed
 * when they subscribe.
 */

export const MONTHS_CAP = 12;

// Unambiguous charset (no O/0/I/1/L) so codes are easy to read/share/type.
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Generate a shareable code like "7K2P-9QRT". Pure; caller ensures uniqueness. */
export function generateCode(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => CODE_CHARSET[crypto.randomInt(0, CODE_CHARSET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** How many months a referrer earns for the next paid referral, given prior earned. */
export function computeReward(alreadyEarned: number, cap = MONTHS_CAP): number {
  return alreadyEarned < cap ? 1 : 0;
}

/** Mask an email for display: "maya@x.com" -> "m***@x.com". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://agentbook.brainliber.com').replace(/\/$/, '');
}

/** Get the caller's referral code, creating one (collision-safe) on first use. */
export async function getOrCreateReferralCode(tenantId: string): Promise<string> {
  const existing = await prisma.billReferralCode.findUnique({ where: { tenantId } });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateCode();
    try {
      const created = await prisma.billReferralCode.create({ data: { tenantId, code } });
      return created.code;
    } catch {
      // Unique collision on code (or a race on tenantId) — retry / re-read.
      const now = await prisma.billReferralCode.findUnique({ where: { tenantId } });
      if (now) return now.code;
    }
  }
  throw new Error('could not allocate a referral code');
}

/**
 * Record an invitee joining via a code. Non-throwing / idempotent-ish:
 * returns false and does nothing on unknown code, self-referral, or a
 * duplicate invitee. Called at signup time.
 */
export async function recordReferralJoin(
  code: string | null | undefined,
  inviteeTenantId: string,
  inviteeEmail?: string | null,
): Promise<boolean> {
  if (!code) return false;
  const normalized = code.trim().toUpperCase();
  const owner = await prisma.billReferralCode.findUnique({ where: { code: normalized } });
  if (!owner) return false; // unknown code
  if (owner.tenantId === inviteeTenantId) return false; // self-referral
  const dup = await prisma.billReferral.findUnique({ where: { inviteeTenantId } });
  if (dup) return false; // already attributed
  try {
    await prisma.billReferral.create({
      data: {
        referrerTenantId: owner.tenantId,
        code: normalized,
        inviteeTenantId,
        inviteeEmail: inviteeEmail ?? null,
        status: 'joined',
      },
    });
    return true;
  } catch {
    return false; // race on inviteeTenantId unique
  }
}

export interface ReferralSummary {
  code: string;
  shareUrl: string;
  monthsEarned: number;
  monthsCap: number;
  invitees: Array<{ maskedEmail: string | null; status: string; joinedAt: string; paidAt: string | null }>;
}

/** Full self-serve summary for the Referrals page. */
export async function getReferralSummary(tenantId: string): Promise<ReferralSummary> {
  const code = await getOrCreateReferralCode(tenantId);
  const referrals = await prisma.billReferral.findMany({
    where: { referrerTenantId: tenantId },
    orderBy: { joinedAt: 'desc' },
  });
  const monthsEarned = Math.min(
    MONTHS_CAP,
    referrals.reduce((sum, r) => sum + (r.rewardMonths || 0), 0),
  );
  return {
    code,
    shareUrl: `${appBaseUrl()}/register?ref=${encodeURIComponent(code)}`,
    monthsEarned,
    monthsCap: MONTHS_CAP,
    invitees: referrals.map((r) => ({
      maskedEmail: maskEmail(r.inviteeEmail),
      status: r.status,
      joinedAt: r.joinedAt.toISOString(),
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    })),
  };
}

/**
 * Called from the Stripe webhook when an invitee's first payment succeeds.
 * Flips their referral joined -> paid, assigns the reward (respecting the cap),
 * then attempts to apply any banked credit to the referrer.
 *
 * Sales-rep-owned codes (BillReferralCode.salesRepId set) skip the
 * reward-months path entirely — those referrals earn the rep commission via
 * accrueSalesRepCommission instead, not free months. Still flips status so
 * the rep's own dashboard shows the invitee as converted.
 */
export async function processInviteePaid(inviteeTenantId: string): Promise<void> {
  const ref = await prisma.billReferral.findUnique({ where: { inviteeTenantId } });
  if (!ref || ref.status === 'paid') return; // no referral, or already processed (idempotent)

  const referralCode = await prisma.billReferralCode.findFirst({ where: { code: ref.code } });
  if (referralCode?.salesRepId) {
    await prisma.billReferral.update({
      where: { id: ref.id },
      data: { status: 'paid', paidAt: new Date() },
    });
    return;
  }

  const prior = await prisma.billReferral.aggregate({
    where: { referrerTenantId: ref.referrerTenantId },
    _sum: { rewardMonths: true },
  });
  const alreadyEarned = prior._sum.rewardMonths ?? 0;
  const reward = computeReward(alreadyEarned);

  await prisma.billReferral.update({
    where: { id: ref.id },
    data: { status: 'paid', paidAt: new Date(), rewardMonths: reward },
  });

  await applyPendingCredits(ref.referrerTenantId);

  // Closes the gap found during the notifications feature design: today the
  // referrer only learns their reward was earned by manually re-checking
  // Settings > Referrals. Best-effort — a notification failure shouldn't
  // roll back the reward itself, which is why this runs after the update.
  try {
    const maskedInvitee = maskEmail(ref.inviteeEmail) ?? 'Someone you invited';
    await createNotification({
      category: 'referral_thanks',
      severity: 'success',
      title: reward > 0 ? "You earned a free month!" : 'Thanks for spreading the word',
      body:
        reward > 0
          ? `${maskedInvitee} just subscribed to AgentBook through your invite — you've earned 1 free month, applied to your account.`
          : `${maskedInvitee} just subscribed to AgentBook through your invite. You've already reached the ${MONTHS_CAP}-month referral cap, but thank you for spreading the word!`,
      ctaLabel: 'View your referrals',
      ctaUrl: '/settings?tab=agentbook&subtab=referrals',
      createdByType: 'system',
      audienceType: 'single',
      audienceFilter: { tenantId: ref.referrerTenantId },
    });
  } catch (err) {
    console.warn('[referrals] referral_thanks notification failed:', err);
  }
}

/**
 * Apply any earned-but-uncredited referral months to the referrer's Stripe
 * customer balance (one month's plan price each). No-op if the referrer has no
 * Stripe customer yet — the credit stays banked and is flushed when they
 * subscribe (call this again from subscription.created). Idempotent via
 * creditedAt.
 */
export async function applyPendingCredits(referrerTenantId: string): Promise<void> {
  const sub = await prisma.billSubscription.findUnique({
    where: { accountId: referrerTenantId },
    include: { plan: true },
  });
  if (!sub?.stripeCustomerId || !sub.plan) return; // banked until they subscribe

  const pending = await prisma.billReferral.findMany({
    where: { referrerTenantId, rewardMonths: { gt: 0 }, creditedAt: null },
    orderBy: { paidAt: 'asc' },
  });
  if (pending.length === 0) return;

  const alreadyCredited = await prisma.billReferral.count({
    where: { referrerTenantId, creditedAt: { not: null } },
  });
  let remaining = Math.max(0, MONTHS_CAP - alreadyCredited);

  const stripe = getStripe();
  for (const r of pending) {
    if (remaining <= 0) break;
    await stripe.customers.createBalanceTransaction(sub.stripeCustomerId, {
      amount: -sub.plan.priceCents, // negative = credit
      currency: sub.plan.currency,
      description: `Referral reward — 1 free month (referral ${r.id})`,
    });
    await prisma.billReferral.update({ where: { id: r.id }, data: { creditedAt: new Date() } });
    remaining -= 1;
  }
}
