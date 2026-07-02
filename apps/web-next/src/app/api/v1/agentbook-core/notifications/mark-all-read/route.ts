/**
 * Mark every unread in-app notification as read for the current tenant —
 * powers the bell dropdown's "Mark all as read" action.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const result = await db.abNotificationRecipient.updateMany({
    where: { tenantId, channel: 'in_app', readAt: null },
    data: { readAt: new Date() },
  });

  return NextResponse.json({ success: true, data: { updated: result.count } });
}
