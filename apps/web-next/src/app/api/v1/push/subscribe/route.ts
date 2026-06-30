/**
 * Store (POST) or clear (DELETE) the caller's Web Push subscription on their
 * tenant config, so the proactive-alerts cron can deliver notifications to the
 * mobile PWA.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { subscription?: unknown };
    const sub = body.subscription;
    if (!sub || typeof sub !== 'object' || !(sub as { endpoint?: unknown }).endpoint) {
      return NextResponse.json({ success: false, error: 'a valid PushSubscription is required' }, { status: 400 });
    }
    await db.abTenantConfig.upsert({
      where: { userId: tenantId },
      update: { pushSubscription: sub as object },
      create: { userId: tenantId, pushSubscription: sub as object },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[push/subscribe POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    await db.abTenantConfig.updateMany({ where: { userId: tenantId }, data: { pushSubscription: undefined } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[push/subscribe DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
