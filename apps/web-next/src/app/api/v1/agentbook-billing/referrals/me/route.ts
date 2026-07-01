import { NextRequest, NextResponse } from 'next/server';
import { getReferralSummary } from '@/lib/billing/referrals';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/referrals/me
 * The caller's referral code, share URL, months earned (cap 12), and invitees.
 * Lazily creates the code on first read.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  try {
    const summary = await getReferralSummary(resolved.tenantId);
    return NextResponse.json({ success: true, data: summary });
  } catch (err) {
    console.error('[referrals/me] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
