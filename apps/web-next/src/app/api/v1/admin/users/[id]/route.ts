/**
 * Admin user actions.
 * PATCH /api/v1/admin/users/[id] — body { action }:
 *   suspend | reactivate  → toggle login access via User.lockedUntil
 *   grantAdmin | revokeAdmin → add/remove the system:admin role
 *
 * Admin-only. You cannot suspend or de-admin your own account (lockout guard).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { success, errors, getAuthToken } from '@/lib/api/response';
import { parseUserAction, SUSPEND_SENTINEL } from '@/lib/admin-users';
import { invalidateAccount } from '@naap/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';
const COMPABLE_PLANS = new Set(['free', 'pro', 'business']);

/**
 * Comp a user onto a plan (billingSource='manual') — or Free — without Stripe.
 * Refuses to touch a real Stripe subscription (that must be changed in Stripe,
 * or our DB desyncs). Represents Free as an active free-plan row so the plan
 * shows consistently everywhere (planCode==='free').
 */
async function setUserPlan(id: string, plan: string): Promise<NextResponse | null> {
  const existing = await prisma.billSubscription.findUnique({ where: { accountId: id } });
  if (existing?.stripeSubscriptionId) {
    return errors.conflict('This user has a real Stripe subscription — change it in Stripe, not here.');
  }
  const billPlan = await prisma.billPlan.findFirst({ where: { code: plan, isActive: true }, select: { id: true } });
  if (!billPlan) return errors.internal(`Plan '${plan}' is not provisioned`);
  await prisma.billSubscription.upsert({
    where: { accountId: id },
    create: { accountId: id, planId: billPlan.id, status: 'active', billingSource: 'manual' },
    update: { planId: billPlan.id, status: 'active', billingSource: 'manual', canceledAt: null },
  });
  invalidateAccount(id);
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const token = getAuthToken(request);
    if (!token) return errors.unauthorized('No auth token provided');
    const sessionUser = await validateSession(token);
    if (!sessionUser) return errors.unauthorized('Invalid or expired session');
    if (!sessionUser.roles.includes(ADMIN_ROLE)) return errors.forbidden('Admin permission required');

    const { id } = await params;
    const body = await request.json().catch(() => null);

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!target) return errors.notFound('User');

    // Plan comp (its own action since it carries a `plan` param).
    if ((body as { action?: string } | null)?.action === 'setPlan') {
      const plan = (body as { plan?: string }).plan ?? '';
      if (!COMPABLE_PLANS.has(plan)) return errors.badRequest("plan must be 'free', 'pro', or 'business'");
      const conflict = await setUserPlan(id, plan);
      if (conflict) return conflict;
      return success({ id, action: 'setPlan', plan });
    }

    const action = parseUserAction(body);
    if (!action) {
      return errors.badRequest('action must be one of: suspend, reactivate, grantAdmin, revokeAdmin, setPlan');
    }

    // Lockout guard: never let an admin lock themselves out.
    if (target.id === sessionUser.id && (action === 'suspend' || action === 'revokeAdmin')) {
      return errors.badRequest('You cannot suspend or remove admin from your own account');
    }

    if (action === 'suspend') {
      await prisma.user.update({ where: { id }, data: { lockedUntil: SUSPEND_SENTINEL } });
    } else if (action === 'reactivate') {
      await prisma.user.update({ where: { id }, data: { lockedUntil: null } });
    } else {
      const role = await prisma.role.findUnique({ where: { name: ADMIN_ROLE }, select: { id: true } });
      if (!role) return errors.internal('Admin role is not provisioned');
      if (action === 'grantAdmin') {
        await prisma.userRole.upsert({
          where: { userId_roleId: { userId: id, roleId: role.id } },
          update: {},
          create: { userId: id, roleId: role.id, grantedBy: sessionUser.id },
        });
      } else {
        await prisma.userRole.deleteMany({ where: { userId: id, roleId: role.id } });
      }
    }

    return success({ id, action });
  } catch (err) {
    console.error('[admin/users/[id] PATCH] failed:', err);
    return errors.internal('Failed to update user');
  }
}
