/**
 * GET /api/v1/admin/sales-reps/recommendations — pending coach recommendations
 * (commission raises / rewards) awaiting admin approval. Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { listPendingRecommendations } from '@/lib/billing/sales-rep-recommendations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes('system:admin')) return errors.forbidden('Admin permission required');

  try {
    return success({ recommendations: await listPendingRecommendations() });
  } catch (err) {
    console.error('[admin/sales-reps/recommendations GET] failed:', err);
    return errors.internal('Failed to list recommendations');
  }
}
