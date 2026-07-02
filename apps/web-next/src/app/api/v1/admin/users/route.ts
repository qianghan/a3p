/**
 * Admin Users API
 * GET /api/v1/admin/users - List all users (admin only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { success, errors, getAuthToken } from '@/lib/api/response';
import { isSuspended } from '@/lib/admin-users';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return errors.unauthorized('No auth token provided');
    }

    const sessionUser = await validateSession(token);
    if (!sessionUser) {
      return errors.unauthorized('Invalid or expired session');
    }

    // Check admin permission
    const isAdmin = sessionUser.roles.includes('system:admin');
    if (!isAdmin) {
      return errors.forbidden('Admin permission required');
    }

    const usersData = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        address: true,
        emailVerified: true,
        lockedUntil: true,
        createdAt: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        _count: {
          select: {
            teamMemberships: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Plan + referral stats — joined separately (tenantId == user.id, no FK
    // relation defined between `public` and `plugin_agentbook_billing`
    // schemas) and merged in-memory rather than per-user queries.
    const [subscriptions, sentCounts, paidReferrals] = await Promise.all([
      prisma.billSubscription.findMany({ select: { accountId: true, plan: { select: { name: true, code: true } } } }),
      prisma.billReferral.groupBy({ by: ['referrerTenantId'], _count: { _all: true } }),
      prisma.billReferral.findMany({ where: { status: 'paid' }, select: { referrerTenantId: true, rewardMonths: true } }),
    ]);
    const planByTenant = new Map(subscriptions.map((s) => [s.accountId, s.plan]));
    const sentByTenant = new Map(sentCounts.map((r) => [r.referrerTenantId, r._count._all]));
    const paidByTenant = new Map<string, number>();
    const rewardByTenant = new Map<string, number>();
    for (const r of paidReferrals) {
      paidByTenant.set(r.referrerTenantId, (paidByTenant.get(r.referrerTenantId) ?? 0) + 1);
      rewardByTenant.set(r.referrerTenantId, (rewardByTenant.get(r.referrerTenantId) ?? 0) + r.rewardMonths);
    }

    // Transform the data to include roles as an array of strings
    const users = usersData.map(user => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      walletAddress: user.address,
      roles: user.roles.map(ur => ur.role.name),
      emailVerified: !!user.emailVerified,
      suspended: isSuspended(user.lockedUntil),
      createdAt: user.createdAt,
      lastLoginAt: null, // Not tracked in this schema
      _count: user._count,
      planName: planByTenant.get(user.id)?.name ?? null,
      invitesSent: sentByTenant.get(user.id) ?? 0,
      invitesPaid: paidByTenant.get(user.id) ?? 0,
      rewardMonthsEarned: rewardByTenant.get(user.id) ?? 0,
    }));

    return success({ users });
  } catch (err) {
    console.error('Error fetching users:', err);
    return errors.internal('Failed to fetch users');
  }
}
