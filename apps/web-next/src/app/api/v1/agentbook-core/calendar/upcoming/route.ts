/**
 * GET /api/v1/agentbook-core/calendar/upcoming?days=30 — calendar events,
 * estimated-tax instalments and open bills in the next N days (1..90).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getUpcoming, UPCOMING_MIN_DAYS, UPCOMING_MAX_DAYS } from '@/lib/mobile/upcoming';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const raw = request.nextUrl.searchParams.get('days');
    const days = raw === null ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < UPCOMING_MIN_DAYS || days > UPCOMING_MAX_DAYS) {
      return NextResponse.json(
        { success: false, error: `days must be an integer between ${UPCOMING_MIN_DAYS} and ${UPCOMING_MAX_DAYS}` },
        { status: 400 },
      );
    }

    const items = await getUpcoming(tenantId, days);
    return NextResponse.json({ success: true, data: { items } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('[agentbook-core/calendar/upcoming] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
