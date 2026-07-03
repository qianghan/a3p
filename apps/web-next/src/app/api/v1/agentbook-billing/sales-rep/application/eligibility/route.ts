import { NextRequest, NextResponse } from 'next/server';
import { checkPartnerEligibility } from '@/lib/billing/sales-rep-application';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/application/eligibility — whether
 * the caller can apply for the Partner Program right now, and why not if
 * not. Callable by any authenticated tenant, not just existing reps — this
 * is the check that drives the "prospect" state of the info page.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const result = await checkPartnerEligibility(resolved.tenantId);
  return NextResponse.json({ success: true, data: result });
}
