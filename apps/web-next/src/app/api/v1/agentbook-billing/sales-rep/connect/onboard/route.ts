import { NextRequest, NextResponse } from 'next/server';
import { createOnboardingLink } from '@/lib/billing/sales-rep-connect';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/agentbook-billing/sales-rep/connect/onboard — returns a
 * Stripe-hosted onboarding URL for the caller (new Connect account, or
 * resuming an incomplete one). Rep-facing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const origin = request.nextUrl.origin;
  try {
    const url = await createOnboardingLink(
      resolved.tenantId,
      `${origin}/sales-rep?stripe_connect=return`,
      `${origin}/sales-rep?stripe_connect=refresh`,
    );
    return NextResponse.json({ success: true, data: { url } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
