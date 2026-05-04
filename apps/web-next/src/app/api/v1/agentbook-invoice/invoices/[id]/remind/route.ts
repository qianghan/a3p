/**
 * Invoice payment reminder — record the event + bump lastRemindedAt.
 *
 * Email delivery via Resend is deferred to a follow-up port. The agent
 * skill currently calls this to log a reminder action and tell the
 * client how overdue / how much is owed.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;

    const invoice = await db.abInvoice.findFirst({
      where: { id, tenantId },
      include: { client: true, payments: true },
    });
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }
    if (invoice.status === 'paid' || invoice.status === 'void') {
      return NextResponse.json(
        { success: false, error: `Cannot remind — invoice is ${invoice.status}` },
        { status: 422 },
      );
    }

    const totalPaid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
    const balance = invoice.amountCents - totalPaid;
    const daysOverdue = Math.max(
      0,
      Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000),
    );
    const tone = daysOverdue > 30 ? 'urgent' : daysOverdue > 14 ? 'firm' : 'gentle';

    await db.abInvoice.update({
      where: { id: invoice.id },
      data: { lastRemindedAt: new Date() },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'invoice.reminder_sent',
        actor: 'agent',
        action: {
          invoiceId: invoice.id,
          tone,
          daysOverdue,
          balance,
          delivered: false,
          note: 'email send deferred; lastRemindedAt + audit event recorded',
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: { tone, daysOverdue, balance, delivered: false },
    });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/:id/remind] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
