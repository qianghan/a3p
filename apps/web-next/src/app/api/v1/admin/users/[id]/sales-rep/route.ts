/**
 * Admin sales rep promotion.
 * POST   /api/v1/admin/users/[id]/sales-rep — promote a user to sales rep:
 *   comps them onto a real plan (no Stripe charge), grants the `sales_rep`
 *   role, and stamps their referral code so signups through it accrue
 *   commission instead of peer reward-months. One atomic transaction.
 * DELETE /api/v1/admin/users/[id]/sales-rep — revoke: removes the role and
 *   marks the profile 'removed'. Leaves the comped subscription and all
 *   historical accrual/payout data untouched (separate manual decision).
 *
 * Admin-only. See docs/plans (jolly-wondering-engelbart) for design.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { getOrCreateReferralCode } from '@/lib/billing/referrals';
import { invalidateAccount } from '@naap/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';
const SALES_REP_ROLE = 'sales_rep';
const ALLOWED_PLANS = new Set(['pro', 'business']);
const ALLOWED_FREQUENCIES = new Set(['monthly', 'quarterly', 'annual']);

async function requireAdminSession(request: NextRequest) {
  const token = getAuthToken(request);
  if (!token) return { error: errors.unauthorized('No auth token provided') };
  const sessionUser = await validateSession(token);
  if (!sessionUser) return { error: errors.unauthorized('Invalid or expired session') };
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return { error: errors.forbidden('Admin permission required') };
  return { sessionUser };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const auth = await requireAdminSession(request);
    if (auth.error) return auth.error;
    const { sessionUser } = auth;

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const plan = body?.plan;
    const commissionBps = Number(body?.commissionBps);
    const payoutFrequency = body?.payoutFrequency ?? 'quarterly';

    if (!ALLOWED_PLANS.has(plan)) {
      return errors.badRequest("plan must be one of: 'pro', 'business'");
    }
    if (!Number.isInteger(commissionBps) || commissionBps <= 0 || commissionBps > 10000) {
      return errors.badRequest('commissionBps must be an integer between 1 and 10000 (basis points, e.g. 2000 = 20%)');
    }
    if (!ALLOWED_FREQUENCIES.has(payoutFrequency)) {
      return errors.badRequest("payoutFrequency must be one of: 'monthly', 'quarterly', 'annual'");
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) return errors.notFound('User');

    const billPlan = await prisma.billPlan.findFirst({ where: { code: plan, isActive: true } });
    if (!billPlan) return errors.internal(`Plan '${plan}' is not provisioned`);

    const existingSub = await prisma.billSubscription.findUnique({ where: { accountId: id } });
    if (existingSub?.stripeSubscriptionId) {
      return errors.conflict(
        'This user has an active real Stripe subscription — cancel or transfer it before promoting to sales rep.',
      );
    }

    const role = await prisma.role.findUnique({ where: { name: SALES_REP_ROLE }, select: { id: true } });
    if (!role) return errors.internal('sales_rep role is not provisioned — run bin/seed-agentbook-defaults.ts');

    await prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: id, roleId: role.id } },
        update: {},
        create: { userId: id, roleId: role.id, grantedBy: sessionUser.id },
      });

      await tx.billSubscription.upsert({
        where: { accountId: id },
        create: {
          accountId: id,
          planId: billPlan.id,
          status: 'active',
          billingSource: 'manual',
        },
        update: {
          planId: billPlan.id,
          status: 'active',
          billingSource: 'manual',
          canceledAt: null,
        },
      });

      await tx.salesRepProfile.upsert({
        where: { tenantId: id },
        create: {
          tenantId: id,
          commissionBps,
          payoutFrequency,
          billingSource: 'manual',
          promotedBy: sessionUser.id,
        },
        update: {
          status: 'active',
          commissionBps,
          payoutFrequency,
          removedAt: null,
          removedBy: null,
        },
      });
    });

    // Outside the transaction: getOrCreateReferralCode does its own retry
    // loop and isn't part of the atomic promotion guarantee (a rep with no
    // code yet is a recoverable state — the sales-rep dashboard's own
    // getOrCreate call would create it lazily anyway).
    const code = await getOrCreateReferralCode(id);
    await prisma.billReferralCode.update({ where: { code }, data: { salesRepId: id } });

    invalidateAccount(id);

    return success({ id, plan, commissionBps, payoutFrequency, referralCode: code });
  } catch (err) {
    console.error('[admin/users/[id]/sales-rep POST] failed:', err);
    return errors.internal('Failed to promote user to sales rep');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const auth = await requireAdminSession(request);
    if (auth.error) return auth.error;
    const { sessionUser } = auth;

    const { id } = await params;
    const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId: id } });
    if (!profile) return errors.notFound('Sales rep profile');

    const role = await prisma.role.findUnique({ where: { name: SALES_REP_ROLE }, select: { id: true } });

    await prisma.$transaction(async (tx) => {
      if (role) {
        await tx.userRole.deleteMany({ where: { userId: id, roleId: role.id } });
      }
      await tx.salesRepProfile.update({
        where: { tenantId: id },
        data: { status: 'removed', removedAt: new Date(), removedBy: sessionUser.id },
      });
    });

    invalidateAccount(id);

    return success({ id, status: 'removed' });
  } catch (err) {
    console.error('[admin/users/[id]/sales-rep DELETE] failed:', err);
    return errors.internal('Failed to revoke sales rep status');
  }
}
