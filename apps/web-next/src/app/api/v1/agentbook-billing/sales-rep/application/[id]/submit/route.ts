import { NextRequest, NextResponse } from 'next/server';
import { signAndSubmitApplication } from '@/lib/billing/sales-rep-contract';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/agentbook-billing/sales-rep/application/[id]/submit — step 5,
 * e-sign and finalize. Body: { signedByName }. IP/user-agent are captured
 * server-side from the request, never trusted from the client.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const signedByName = typeof body?.signedByName === 'string' ? body.signedByName : '';

  const signerIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const signerUserAgent = request.headers.get('user-agent') || 'unknown';

  try {
    const result = await signAndSubmitApplication(resolved.tenantId, id, {
      signedByName,
      signerIp,
      signerUserAgent,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
