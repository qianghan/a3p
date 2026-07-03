import { NextRequest, NextResponse } from 'next/server';
import { getApplicationContractPreview } from '@/lib/billing/sales-rep-contract';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/application/[id]/contract-preview
 * — steps 3-5 read model: the personalized disclosure sections, which are
 * already acknowledged, and (once all required acks are in) the full
 * assembled agreement text for the step-5 final read before signing.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const { id } = await params;
  try {
    const preview = await getApplicationContractPreview(resolved.tenantId, id);
    return NextResponse.json({ success: true, data: preview });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
