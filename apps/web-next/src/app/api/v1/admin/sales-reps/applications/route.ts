/**
 * GET /api/v1/admin/sales-reps/applications — list sales-rep applications for
 * admin review (submitted/under_review/more_info by default; ?includeDecided=1
 * also returns approved/rejected). Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { listApplicationsForReview } from '@/lib/billing/sales-rep-application-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return errors.forbidden('Admin permission required');

  try {
    const includeDecided = request.nextUrl.searchParams.get('includeDecided') === '1';
    const applications = await listApplicationsForReview({ includeDecided });
    return success({ applications });
  } catch (err) {
    console.error('[admin/sales-reps/applications GET] failed:', err);
    return errors.internal('Failed to list applications');
  }
}
