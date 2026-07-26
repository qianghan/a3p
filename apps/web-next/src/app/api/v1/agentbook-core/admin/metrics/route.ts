/**
 * GET /api/v1/agentbook-core/admin/metrics — platform-wide KPIs for the admin
 * overview dashboard (users, signup trend, MRR/ARR, conversion, plan mix, and
 * sales-rep performance). Admin-only (same requireAdmin as other admin routes).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { computePlatformMetrics } from '@/lib/admin-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;
  try {
    const metrics = await computePlatformMetrics();
    return NextResponse.json({ success: true, data: metrics });
  } catch (err) {
    console.error('[admin/metrics] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
