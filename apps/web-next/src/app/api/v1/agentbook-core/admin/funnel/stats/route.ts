/**
 * GET /api/v1/agentbook-core/admin/funnel/stats?days=30
 *
 * P0-7: the revenue funnel as a queryable table — event counts and unique
 * tenants for the trailing N days, ordered by first occurrence (which reads
 * as the funnel stages top-to-bottom).
 *
 * Admin-gated, read-only. Funnel events are PII-free by construction
 * (see packages/billing/src/funnel.ts).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getFunnelStats } from '@naap/billing';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;

  try {
    const days = Math.min(
      365,
      Math.max(1, parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10) || 30),
    );
    const stats = await getFunnelStats(days);
    return NextResponse.json({ success: true, data: { days, stages: stats } });
  } catch (err) {
    console.error('[admin/funnel/stats] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
