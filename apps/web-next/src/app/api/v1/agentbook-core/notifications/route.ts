/**
 * User-facing notification inbox — powers the dashboard bell dropdown and
 * the full /agentbook/notifications page.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const params = request.nextUrl.searchParams;
  const unreadOnly = params.get('unreadOnly') === 'true';
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '30', 10) || 30));

  const recipients = await db.abNotificationRecipient.findMany({
    where: {
      tenantId,
      channel: 'in_app',
      ...(unreadOnly ? { readAt: null } : {}),
    },
    include: { notification: true },
    orderBy: { deliveredAt: 'desc' },
    take: limit,
  });

  const unreadCount = await db.abNotificationRecipient.count({
    where: { tenantId, channel: 'in_app', readAt: null },
  });

  const items = recipients.map((r) => ({
    id: r.id,
    category: r.notification.category,
    severity: r.notification.severity,
    title: r.notification.title,
    body: r.notification.body,
    ctaLabel: r.notification.ctaLabel,
    ctaUrl: r.notification.ctaUrl,
    deliveredAt: r.deliveredAt,
    readAt: r.readAt,
    actedAt: r.actedAt,
  }));

  return NextResponse.json({ success: true, data: { notifications: items, unreadCount } });
}
