/**
 * Void an invoice — flip status, post a reversing journal entry,
 * decrement client totalBilledCents. Refuses if there are payments.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

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

    const invoice = await db.abInvoice.findFirst({
      where: { id, tenantId },
      include: { payments: true },
    });
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }
    if (invoice.status === 'void') {
      return NextResponse.json({ success: false, error: 'Invoice is already voided' }, { status: 422 });
    }
    if (invoice.status === 'paid') {
      return NextResponse.json({ success: false, error: 'Cannot void a paid invoice' }, { status: 422 });
    }

    const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amountCents, 0);
    if (totalPaid > 0) {
      return NextResponse.json(
        { success: false, error: 'Cannot void invoice with existing payments. Refund payments first.' },
        { status: 422 },
      );
    }

    // Mirror-reverse the ORIGINAL journal entry's own lines (swap debit/credit
    // per line, same accounts) rather than reconstructing an AR/Revenue-only
    // reversal from amountCents. Since Launch-gap PR-6, amountCents is the
    // tax-inclusive grand total while the original entry only ever credited
    // Revenue the subtotal (tax went to a 2100/2200 liability account) — a
    // flat "debit Revenue / credit AR by amountCents" reversal would leave
    // Revenue over-reversed and the tax-liability account never cleared for
    // any AU/CA invoice. Mirroring the real lines is correct for every case
    // (untaxed 2-line entries included) and needs no jurisdiction knowledge.
    const originalLines = invoice.journalEntryId
      ? await db.abJournalLine.findMany({ where: { entryId: invoice.journalEntryId } })
      : [];
    if (invoice.journalEntryId && originalLines.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Original journal entry not found' },
        { status: 422 },
      );
    }

    const updated = await db.$transaction(async (tx) => {
      if (originalLines.length > 0) {
        await tx.abJournalEntry.create({
          data: {
            tenantId,
            date: new Date(),
            memo: `VOID - Reverse Invoice ${invoice.number}`,
            // 'invoice_void', not 'invoice' — the original creation entry
            // already holds (tenantId, 'invoice', invoice.id), and G-021's
            // @@unique([tenantId, sourceType, sourceId]) would reject a
            // second row under that same tuple (confirmed: this reversal
            // insert throws P2002 under the old sourceType before this fix).
            sourceType: 'invoice_void',
            sourceId: invoice.id,
            verified: true,
            lines: {
              create: originalLines.map((l) => ({
                tenantId, // G-009
                accountId: l.accountId,
                debitCents: l.creditCents,
                creditCents: l.debitCents,
                description: `Reverse: ${l.description || `Invoice ${invoice.number}`}`,
              })),
            },
          },
        });
      }

      const inv = await tx.abInvoice.update({
        where: { id: invoice.id },
        data: { status: 'void' },
      });

      await tx.abClient.update({
        where: { id: invoice.clientId },
        data: { totalBilledCents: { decrement: invoice.amountCents } },
      });

      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'invoice.voided',
          actor: 'agent',
          action: {
            invoiceId: invoice.id,
            number: invoice.number,
            amountCents: invoice.amountCents,
          },
          constraintsPassed: ['balance_invariant'],
          verificationResult: 'passed',
        },
      });

      return inv;
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/:id/void] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
