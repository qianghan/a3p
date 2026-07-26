/**
 * Invoice send — flip status to "sent", emit event, AND email the client a
 * link to the public pay page. Email is best-effort: the status transition
 * still succeeds if delivery fails (no RESEND_API_KEY, no client email), and
 * the response reports `emailSent` so callers can surface it.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { sendNotificationEmail } from '@/lib/email';
import { getAppBaseUrl } from '@/lib/agentbook-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    const invoice = await db.abInvoice.findFirst({ where: { id, tenantId }, include: { client: true } });
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }
    if (invoice.status === 'void') {
      return NextResponse.json({ success: false, error: 'Cannot send a voided invoice' }, { status: 422 });
    }
    if (invoice.status === 'paid') {
      return NextResponse.json({ success: false, error: 'Invoice is already paid' }, { status: 422 });
    }

    const updated = await db.$transaction(async (tx) => {
      const inv = await tx.abInvoice.update({
        where: { id },
        data: { status: 'sent' },
      });
      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'invoice.sent',
          actor: 'agent',
          action: { invoiceId: invoice.id, number: invoice.number },
        },
      });
      return inv;
    });

    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'invoice.send',
      entityType: 'AbInvoice',
      entityId: id,
      before: { status: invoice.status },
      after: { status: updated.status, number: invoice.number },
    });

    // Email the client a link to the public pay page. Best-effort — never
    // fails the send (status already transitioned above).
    let emailSent = false;
    const clientEmail = invoice.client?.email;
    if (clientEmail) {
      try {
        const payUrl = `${getAppBaseUrl(request)}/pay/${invoice.id}`;
        const amount = (invoice.amountCents / 100).toLocaleString('en-US', {
          style: 'currency', currency: invoice.currency || 'USD', maximumFractionDigits: 2,
        });
        const due = new Date(invoice.dueDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const r = await sendNotificationEmail(clientEmail, {
          title: `Invoice ${invoice.number} — ${amount} due ${due}`,
          body: `You have a new invoice (${invoice.number}) for ${amount}, due ${due}. View the details and pay online using the button below.`,
          ctaLabel: 'View & pay invoice',
          ctaUrl: payUrl,
        });
        emailSent = r.success;
        if (!r.success) console.warn('[invoice/send] email not delivered:', r.error);
      } catch (mailErr) {
        console.warn('[invoice/send] email threw (non-fatal):', mailErr);
      }
    }

    return NextResponse.json({ success: true, data: updated, emailSent });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/:id/send] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
