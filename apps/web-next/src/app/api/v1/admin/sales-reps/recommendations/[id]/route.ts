/**
 * PATCH /api/v1/admin/sales-reps/recommendations/:id — { action: 'approve'|'dismiss' }.
 * Approving a commission_raise applies it; a reward notifies the rep. Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { decideRecommendation, RecommendationError } from '@/lib/billing/sales-rep-recommendations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes('system:admin')) return errors.forbidden('Admin permission required');

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== 'approve' && action !== 'dismiss') {
    return errors.badRequest("action must be 'approve' or 'dismiss'");
  }
  try {
    return success(await decideRecommendation(id, sessionUser.id, action));
  } catch (err) {
    if (err instanceof RecommendationError) return errors.badRequest(err.message);
    console.error('[admin/sales-reps/recommendations/[id] PATCH] failed:', err);
    return errors.internal('Failed to update recommendation');
  }
}
