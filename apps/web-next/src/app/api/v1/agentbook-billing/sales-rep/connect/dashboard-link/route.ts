import { NextRequest, NextResponse } from 'next/server';
import { createExpressDashboardLoginLink } from '@/lib/billing/sales-rep-connect';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/connect/dashboard-link — a fresh,
 * one-time-use link into the caller's own Stripe Express dashboard, where
 * they can update their bank account directly with Stripe. Only available
 * once payouts are enabled.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  try {
    const url = await createExpressDashboardLoginLink(resolved.tenantId);
    return NextResponse.json({ success: true, data: { url } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
