/**
 * GET /api/v1/agentbook-invoice/invoices/:id/public
 *
 * Public, unauthenticated read of an invoice for the client-facing pay page
 * (`/pay/[invoiceId]`). Returns only non-sensitive presentation fields — no
 * tenant internals. Drafts and voided invoices are not exposed. Viewing a
 * "sent" invoice marks it "viewed" (best-effort).
 *
 * This replaces the previous cross-service fetch to the legacy Express
 * backend (localhost:4052), which does not run on the production Next.js
 * deployment — so the pay page rendered nothing in prod.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const invoice = await db.abInvoice.findUnique({
    where: { id },
    include: { client: true, lines: true },
  });

  // Don't leak drafts/voided invoices, or non-existent ids.
  if (!invoice || invoice.status === 'draft' || invoice.status === 'void') {
    return NextResponse.json({ success: false, error: 'Invoice not available' }, { status: 404 });
  }

  // Mark a first view (best-effort; never blocks the response).
  if (invoice.status === 'sent') {
    await db.abInvoice.update({ where: { id }, data: { status: 'viewed' } }).catch(() => {});
  }

  return NextResponse.json({
    success: true,
    data: {
      number: invoice.number,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      issuedDate: invoice.createdAt.toISOString(),
      dueDate: invoice.dueDate.toISOString(),
      status: invoice.status === 'sent' ? 'viewed' : invoice.status,
      clientName: invoice.client?.name ?? undefined,
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        rateCents: l.rateCents,
        amountCents: l.amountCents,
      })),
    },
  });
}
