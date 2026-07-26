/**
 * POST /api/v1/agentbook-invoice/invoices/:id/pay-link
 * Creates a Stripe Checkout link so the client can pay this invoice by card;
 * the charge settles to the freelancer's connected account. Sets
 * invoice.paymentUrl (so the public pay page's "Pay Now" appears) and returns it.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getAppBaseUrl } from '@/lib/agentbook-config';
import { createInvoicePayLink, InvoicePayLinkError } from '@/lib/invoice-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;
  const { id } = await params;
  try {
    const url = await createInvoicePayLink(id, tenantId, getAppBaseUrl(request));
    return NextResponse.json({ success: true, data: { paymentUrl: url } });
  } catch (err) {
    if (err instanceof InvoicePayLinkError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 422 });
    }
    console.error('[invoice/pay-link] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
