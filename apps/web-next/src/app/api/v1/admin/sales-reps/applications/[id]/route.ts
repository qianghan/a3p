/**
 * GET   /api/v1/admin/sales-reps/applications/:id — full application detail.
 * PATCH /api/v1/admin/sales-reps/applications/:id — decide an application.
 *   body: { action: 'approve'|'reject'|'request_info', ... }
 *     approve      → { commissionBps?, payoutFrequency?, notes? }
 *     reject       → { reason }
 *     request_info → { message }
 * Approving provisions the rep (role + profile + referral code) and notifies
 * the applicant. Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import {
  getApplicationForReview,
  approveApplication,
  rejectApplication,
  requestMoreInfo,
  ApplicationReviewError,
} from '@/lib/billing/sales-rep-application-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

async function requireAdmin(request: NextRequest) {
  const token = getAuthToken(request);
  if (!token) return { error: errors.unauthorized('No auth token provided'), sessionUser: null };
  const sessionUser = await validateSession(token);
  if (!sessionUser) return { error: errors.unauthorized('Invalid or expired session'), sessionUser: null };
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return { error: errors.forbidden('Admin permission required'), sessionUser: null };
  return { error: null, sessionUser };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  try {
    return success({ application: await getApplicationForReview(id) });
  } catch (err) {
    if (err instanceof ApplicationReviewError) return errors.notFound('Application');
    console.error('[admin/sales-reps/applications/[id] GET] failed:', err);
    return errors.internal('Failed to load application');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { error, sessionUser } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;

  try {
    if (action === 'approve') {
      const commissionBps = body?.commissionBps != null ? Number(body.commissionBps) : undefined;
      const result = await approveApplication(id, sessionUser.id, {
        commissionBps,
        payoutFrequency: body?.payoutFrequency,
        notes: body?.notes,
      });
      return success({ action, ...result });
    }
    if (action === 'reject') {
      const result = await rejectApplication(id, sessionUser.id, String(body?.reason ?? ''));
      return success({ action, ...result });
    }
    if (action === 'request_info') {
      const result = await requestMoreInfo(id, sessionUser.id, String(body?.message ?? ''));
      return success({ action, ...result });
    }
    return errors.badRequest("action must be one of: 'approve', 'reject', 'request_info'");
  } catch (err) {
    if (err instanceof ApplicationReviewError) return errors.badRequest(err.message);
    console.error('[admin/sales-reps/applications/[id] PATCH] failed:', err);
    return errors.internal('Failed to update application');
  }
}
