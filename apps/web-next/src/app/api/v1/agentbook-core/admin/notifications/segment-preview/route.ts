/**
 * Live audience-size preview for the notification composer — lets an admin
 * see "this will reach N users" before sending, without actually creating a
 * notification row. Reuses the exact same resolver dispatch uses, so the
 * preview count can never drift from what actually gets sent.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { resolveAudienceTenantIds } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  const body = await request.json().catch(() => null);
  if (!body?.audienceType) {
    return NextResponse.json({ success: false, error: 'audienceType is required' }, { status: 400 });
  }

  const tenantIds = await resolveAudienceTenantIds(body.audienceType, body.audienceFilter);
  return NextResponse.json({ success: true, data: { count: tenantIds.length } });
}
