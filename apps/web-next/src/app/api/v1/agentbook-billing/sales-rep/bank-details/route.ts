import { NextRequest, NextResponse } from 'next/server';
import { setSalesRepBankDetails } from '@/lib/billing/sales-rep';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/agentbook-billing/sales-rep/bank-details
 * Stores payout bank details (encrypted at rest via agentbook-bank-token.ts).
 * Write-only from this route — plaintext is only ever decrypted by admin at
 * actual payout time (see admin/sales-reps/payouts/[id] mark-paid route).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const body = await request.json().catch(() => null);
  const details = body?.bankDetails;
  if (typeof details !== 'string' || details.trim().length < 5) {
    return NextResponse.json({ success: false, error: 'bankDetails must be a non-empty string' }, { status: 400 });
  }

  try {
    await setSalesRepBankDetails(resolved.tenantId, details.trim());
    return NextResponse.json({ success: true, data: { saved: true } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'Not a sales rep, or sales rep profile not found' },
      { status: 403 },
    );
  }
}
