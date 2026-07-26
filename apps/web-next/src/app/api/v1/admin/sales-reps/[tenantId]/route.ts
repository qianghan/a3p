/**
 * PATCH /api/v1/admin/sales-reps/:tenantId — edit an existing rep's commission
 * rate and/or payout cadence. body: { commissionBps?, payoutFrequency? }.
 * Does NOT touch their plan (unlike the direct-invite POST). Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { updateRepCommission, RepAdminError } from '@/lib/billing/sales-rep-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ tenantId: string }> }): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return errors.forbidden('Admin permission required');

  const { tenantId } = await params;
  const body = await request.json().catch(() => null);
  try {
    const result = await updateRepCommission(tenantId, {
      commissionBps: body?.commissionBps != null ? Number(body.commissionBps) : undefined,
      payoutFrequency: body?.payoutFrequency,
    });
    return success(result);
  } catch (err) {
    if (err instanceof RepAdminError) return errors.badRequest(err.message);
    console.error('[admin/sales-reps/[tenantId] PATCH] failed:', err);
    return errors.internal('Failed to update sales rep');
  }
}
