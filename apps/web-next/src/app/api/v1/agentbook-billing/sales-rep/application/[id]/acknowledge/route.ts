import { NextRequest, NextResponse } from 'next/server';
import { setApplicationAcknowledgment } from '@/lib/billing/sales-rep-contract';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import type { LiabilitySectionKey } from '@/lib/billing/sales-rep-contract-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/agentbook-billing/sales-rep/application/[id]/acknowledge —
 * step 3 (per-section disclosure checkboxes) and step 4 (taxpayer-info
 * notice) of the application. Body: { sectionKey?, taxpayerNotice?: true,
 * acknowledged: boolean }. Exactly one of sectionKey/taxpayerNotice is set.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { sectionKey, taxpayerNotice, acknowledged } = body as {
    sectionKey?: LiabilitySectionKey;
    taxpayerNotice?: boolean;
    acknowledged?: boolean;
  };
  if (typeof acknowledged !== 'boolean') {
    return NextResponse.json({ success: false, error: '"acknowledged" must be a boolean' }, { status: 400 });
  }
  if (!sectionKey && !taxpayerNotice) {
    return NextResponse.json(
      { success: false, error: 'Provide either "sectionKey" or "taxpayerNotice: true"' },
      { status: 400 },
    );
  }

  try {
    const application = await setApplicationAcknowledgment(
      resolved.tenantId,
      id,
      { sectionKey, taxpayerNotice },
      acknowledged,
    );
    return NextResponse.json({ success: true, data: { application } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
