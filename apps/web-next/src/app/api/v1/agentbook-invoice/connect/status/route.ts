/**
 * GET /api/v1/agentbook-invoice/connect/status
 * Returns whether the tenant can accept card payments on invoices (Connect
 * account exists + onboarding complete). Refreshes from Stripe.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { refreshInvoiceConnectStatus } from '@/lib/invoice-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;
  try {
    const status = await refreshInvoiceConnectStatus(tenantId);
    return NextResponse.json({ success: true, data: status });
  } catch (err) {
    console.error('[invoice/connect/status] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
