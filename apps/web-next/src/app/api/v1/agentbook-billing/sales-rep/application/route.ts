import { NextRequest, NextResponse } from 'next/server';
import { getLatestApplication, startOrResumeApplication } from '@/lib/billing/sales-rep-application';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/agentbook-billing/sales-rep/application — the caller's latest application, or null. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  const application = await getLatestApplication(resolved.tenantId);
  return NextResponse.json({ success: true, data: { application } });
}

/**
 * POST /api/v1/agentbook-billing/sales-rep/application — start a new draft
 * application, or resume an existing one. Rejects with a specific reason
 * if the caller is ineligible, mid-cooldown, or already has an application
 * in a non-draft state.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  try {
    const application = await startOrResumeApplication(resolved.tenantId);
    return NextResponse.json({ success: true, data: { application } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
