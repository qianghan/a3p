/**
 * Void an invoice — the ONE void path (POST invoices/:id/void and PATCH
 * {status:'void'} both land here): mirror-reverse the revenue entry, return
 * sold stock (stock_sale_void), flip status, decrement the client total.
 * Refuses paid / already-void / invoices with payments.
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { voidInvoiceCogs } from '@/lib/inventory';

export async function voidInvoice(tenantId: string, id: string): Promise<NextResponse> {
  const invoice = await db.abInvoice.findFirst({
    where: { id, tenantId },
    include: { payments: true, lines: true },
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

    // PR 5B: return sold stock at the value it left with (stock_sale_void / line.id).
    await voidInvoiceCogs(tx, tenantId, {
      invoiceNumber: invoice.number,
      date: new Date(),
      lineIds: (invoice.lines ?? []).filter((l) => l.itemId).map((l) => l.id),
    });

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
}
