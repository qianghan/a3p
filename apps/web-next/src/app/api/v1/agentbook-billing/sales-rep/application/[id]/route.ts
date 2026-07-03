import { NextRequest, NextResponse } from 'next/server';
import { saveApplicationDraft } from '@/lib/billing/sales-rep-application';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/agentbook-billing/sales-rep/application/[id] — save
 * progress on steps 1-2 of the application (fit answers + jurisdiction).
 * Only the owning tenant's own draft can be updated; steps 3-5
 * (disclosures, e-sign, finalize) live under ./acknowledge and ./submit.
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

  const { answers, jurisdiction } = body as { answers?: Record<string, unknown>; jurisdiction?: string };

  try {
    const application = await saveApplicationDraft(resolved.tenantId, id, { answers, jurisdiction });
    return NextResponse.json({ success: true, data: { application } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
