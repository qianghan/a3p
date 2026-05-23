/**
 * GET /api/v1/agentbook-invoice/invoices/:id/pdf — serve a real PDF
 * (G-OLD-006 / PR 29).
 *
 * The legacy plugin endpoint at /agentbook-invoice/invoices/:id/pdf served
 * HTML with Content-Type: text/html — customers receiving "PDF invoices"
 * via email got HTML files. This Next.js route serves a real
 * application/pdf binary built via @react-pdf/renderer.
 *
 * Tenant resolution: standard safeResolveAgentbookTenant. Public-link
 * access (signed token from PR 7) is supported via ?t=<token>; this lets
 * clients receiving an emailed link download the PDF without logging in.
 */

import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { renderInvoicePdf, type InvoicePdfData } from '@/lib/agentbook-invoice-pdf';

// Inline HMAC verification — mirrors plugins/agentbook-invoice/backend/src/
// invoice-signed-link.ts. We don't cross-import plugin internals into the
// Next.js layer; keeping a single source of truth was attempted but the
// TS path setup doesn't expose plugin src to apps/web-next. The function
// is small enough to duplicate; both implementations must stay in sync.
const SIGNED_LINK_SECRET =
  process.env.INVOICE_PUBLIC_LINK_SECRET ||
  (process.env.NODE_ENV === 'test' ||
  (process.env.NODE_ENV !== 'production' &&
    (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'development'))
    ? 'dev-only-rotate-in-prod'
    : '');

function verifyInvoiceLink(
  invoiceId: string,
  tenantId: string,
  token: string | undefined | null,
): boolean {
  if (!token || !SIGNED_LINK_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return false;
  const payload = `${invoiceId}.${tenantId}.${exp}`;
  const expected = createHmac('sha256', SIGNED_LINK_SECRET).update(payload).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const token = request.nextUrl.searchParams.get('t');

  // Resolve invoice + tenant. Two auth paths:
  //   1. Signed link (token in ?t=) — public access, no session needed
  //   2. Authenticated session — must match invoice tenantId
  let invoice: Awaited<ReturnType<typeof db.abInvoice.findUnique>> = null;
  let tenantId: string | null = null;

  if (token) {
    // Look up first without tenant filter; verify the signed token covers
    // the actual invoice's tenant. Same pattern as the plugin's public
    // endpoint from PR 7.
    invoice = await db.abInvoice.findUnique({
      where: { id },
      include: { lines: true, client: true } as never,
    });
    if (!invoice) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const inv = invoice as unknown as { tenantId: string };
    if (!verifyInvoiceLink(id, inv.tenantId, token)) {
      return NextResponse.json({ error: 'invalid or expired link' }, { status: 403 });
    }
    tenantId = inv.tenantId;
  } else {
    // Standard session auth.
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    tenantId = resolved.tenantId;
    invoice = await db.abInvoice.findFirst({
      where: { id, tenantId },
      include: { lines: true, client: true } as never,
    });
    if (!invoice) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
  }

  // Pull tenant company info for the header block.
  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId! } });

  const invRecord = invoice as unknown as {
    number: string;
    issuedDate: Date | string;
    dueDate: Date | string;
    status: string;
    amountCents: number;
    taxCents?: number | null;
    subtotalCents?: number | null;
    currency: string;
    notes?: string | null;
    client: { name: string; email?: string | null; address?: string | null };
    lines: Array<{
      description: string;
      quantity: number;
      rateCents: number;
      amountCents: number;
    }>;
  };

  const data: InvoicePdfData = {
    number: invRecord.number,
    issuedDate: invRecord.issuedDate,
    dueDate: invRecord.dueDate,
    status: invRecord.status,
    amountCents: invRecord.amountCents,
    taxCents: invRecord.taxCents,
    subtotalCents: invRecord.subtotalCents,
    currency: invRecord.currency,
    notes: invRecord.notes,
    client: {
      name: invRecord.client?.name ?? 'Client',
      email: invRecord.client?.email,
      address: invRecord.client?.address,
    },
    lines: (invRecord.lines || []).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      rateCents: l.rateCents,
      amountCents: l.amountCents,
    })),
    company: {
      name: config?.companyName || 'AgentBook',
      email: config?.companyEmail ?? null,
      address: config?.companyAddress ?? null,
      phone: config?.companyPhone ?? null,
    },
  };

  try {
    const pdf = await renderInvoicePdf(data);
    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invRecord.number}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    console.error('[invoice/pdf] render failed:', err);
    return NextResponse.json({ error: 'pdf render failed' }, { status: 500 });
  }
}
