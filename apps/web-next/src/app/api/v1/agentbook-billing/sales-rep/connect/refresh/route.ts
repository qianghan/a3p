import { NextRequest, NextResponse } from 'next/server';
import { refreshConnectStatus } from '@/lib/billing/sales-rep-connect';
import { getSalesRepSummary } from '@/lib/billing/sales-rep';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/agentbook-billing/sales-rep/connect/refresh — re-pulls the
 * caller's Connect account status from Stripe. Called when the dashboard
 * detects a return from Stripe onboarding, since return_url firing doesn't
 * guarantee onboarding actually completed (the account.updated webhook is
 * the durable source of truth — this is just for immediate UI feedback).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  await refreshConnectStatus(resolved.tenantId);
  const summary = await getSalesRepSummary(resolved.tenantId);
  return NextResponse.json({ success: true, data: { payoutStatus: summary.profile.payoutStatus } });
}
