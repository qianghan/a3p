/**
 * Mark a single in-app notification as read (and optionally acted-on, when
 * the user clicked its CTA rather than just opening the dropdown).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const acted = body?.acted === true;

  // Scope the update to this tenant's own row — a recipient id from another
  // tenant must not be markable as read via this endpoint.
  const result = await db.abNotificationRecipient.updateMany({
    where: { id, tenantId },
    data: { readAt: new Date(), ...(acted ? { actedAt: new Date() } : {}) },
  });

  if (result.count === 0) {
    return NextResponse.json({ success: false, error: 'Notification not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
