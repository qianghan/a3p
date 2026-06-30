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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

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
    const action = parseUserAction(await request.json().catch(() => null));
    if (!action) {
      return errors.badRequest('action must be one of: suspend, reactivate, grantAdmin, revokeAdmin');
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!target) return errors.notFound('User');

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
