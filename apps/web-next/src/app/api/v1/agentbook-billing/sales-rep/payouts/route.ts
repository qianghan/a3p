import { NextRequest, NextResponse } from 'next/server';
import { listSalesRepPayouts, submitSalesRepPayout } from '@/lib/billing/sales-rep';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/agentbook-billing/sales-rep/payouts — the caller's payout/invoice history. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const payouts = await listSalesRepPayouts(resolved.tenantId);
  return NextResponse.json({ success: true, data: { payouts } });
}

/**
 * POST /api/v1/agentbook-billing/sales-rep/payouts — submit a commission
 * invoice for the most recently closed payout period. One per period; the
 * lib function throws a descriptive error if nothing's due or it's already
 * been submitted, which we surface directly rather than a generic 500.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  try {
    const payout = await submitSalesRepPayout(resolved.tenantId);
    return NextResponse.json({ success: true, data: payout });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
