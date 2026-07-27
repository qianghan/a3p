/**
 * POST /api/v1/admin/sales-reps/run-coach — manually run the autonomous
 * rep-coach now (same work as the weekly cron: message active reps, detect
 * milestones, queue commission/reward recommendations, send the admin digest).
 * Admin-only — authenticated by the admin session, not CRON_SECRET, so admins
 * can trigger it on demand without the cron secret.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { runRepCoach } from '@/lib/billing/sales-rep-coach';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes('system:admin')) return errors.forbidden('Admin permission required');

  try {
    const result = await runRepCoach();
    return success(result);
  } catch (err) {
    console.error('[admin/sales-reps/run-coach] failed:', err);
    return errors.internal('Failed to run rep coach');
  }
}
