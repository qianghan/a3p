/**
 * PATCH /api/v1/admin/sales-reps/marketing-videos/[id] — edit a video's
 * title/url/description/sortOrder, or toggle isActive to hide/show it
 * without deleting it. Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { editPartnerMarketingVideo } from '@/lib/billing/partner-marketing-kit';

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return errors.badRequest('Invalid request body');
  }

  const { title, url, description, sortOrder, isActive } = body as {
    title?: string; url?: string; description?: string | null; sortOrder?: number; isActive?: boolean;
  };

  try {
    const video = await editPartnerMarketingVideo(id, { title, url, description, sortOrder, isActive });
    return success({ video });
  } catch (err) {
    return errors.badRequest(err instanceof Error ? err.message : String(err));
  }
}
