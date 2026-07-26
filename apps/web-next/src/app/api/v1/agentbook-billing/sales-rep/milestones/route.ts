import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeMilestoneProgress, detectAndRecordMilestones } from '@/lib/billing/sales-rep-milestones';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/milestones
 * The caller's milestone progress for their own sales-rep dashboard. Also
 * lazily records + congratulates any milestone newly crossed since last load
 * (idempotent), so recognition fires even without waiting for the coach cron.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  try {
    // Detect first so freshly-crossed milestones show as achieved on this load.
    await detectAndRecordMilestones(resolved.tenantId).catch(() => {});
    const progress = await computeMilestoneProgress(resolved.tenantId);
    return NextResponse.json({ success: true, data: progress });
  } catch {
    return NextResponse.json({ success: false, error: 'Not a sales rep, or progress unavailable' }, { status: 403 });
  }
}
