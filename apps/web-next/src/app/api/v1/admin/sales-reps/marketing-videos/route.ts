/**
 * GET  /api/v1/admin/sales-reps/marketing-videos — all videos (incl. hidden), for the admin management UI.
 * POST /api/v1/admin/sales-reps/marketing-videos — add a new YouTube video to the gated marketing kit.
 * Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { listAllMarketingVideos, createMarketingVideo } from '@/lib/billing/partner-marketing-videos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

async function requireAdmin(request: NextRequest) {
  const token = getAuthToken(request);
  if (!token) return { error: errors.unauthorized('No auth token provided') };
  const sessionUser = await validateSession(token);
  if (!sessionUser) return { error: errors.unauthorized('Invalid or expired session') };
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return { error: errors.forbidden('Admin permission required') };
  return { sessionUser };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const videos = await listAllMarketingVideos();
  return success({ videos });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const { sessionUser } = auth;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : undefined;
  const sortOrder = typeof body?.sortOrder === 'number' ? body.sortOrder : undefined;

  if (!title || !url) {
    return errors.badRequest('title and url are required');
  }

  try {
    const video = await createMarketingVideo({ title, url, description, sortOrder, createdBy: sessionUser.id });
    return success({ video });
  } catch (err) {
    return errors.badRequest(err instanceof Error ? err.message : String(err));
  }
}
