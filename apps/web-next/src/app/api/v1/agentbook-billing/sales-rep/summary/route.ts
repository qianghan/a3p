import { NextRequest, NextResponse } from 'next/server';
import { getSalesRepSummary } from '@/lib/billing/sales-rep';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/summary
 * The caller's own sales-rep dashboard data: invitee list, revenue/commission
 * totals, and profile settings. 403s for non-reps (no SalesRepProfile row).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  try {
    const summary = await getSalesRepSummary(resolved.tenantId);
    return NextResponse.json({ success: true, data: summary });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'Not a sales rep, or sales rep profile not found' },
      { status: 403 },
    );
  }
}
