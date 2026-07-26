/**
 * POST /api/v1/agentbook-invoice/connect/onboard
 * Starts (or resumes) Stripe Connect onboarding so the freelancer can receive
 * card payments on their invoices. Returns a Stripe-hosted onboarding URL.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getAppBaseUrl } from '@/lib/agentbook-config';
import { createInvoiceOnboardingLink } from '@/lib/invoice-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;
  try {
    const base = getAppBaseUrl(request);
    // The AgentBook settings panel lives under ?tab=agentbook and reads its
    // own sub-tab from ?subtab — so land the user back on Payments.
    const url = await createInvoiceOnboardingLink(
      tenantId,
      `${base}/settings?tab=agentbook&subtab=payments`,
      `${base}/settings?tab=agentbook&subtab=payments`,
    );
    return NextResponse.json({ success: true, data: { url } });
  } catch (err) {
    console.error('[invoice/connect/onboard] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
