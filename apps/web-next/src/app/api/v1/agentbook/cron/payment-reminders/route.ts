/**
 * Payment Reminders Cron — records a reminder event (+ bumps lastRemindedAt)
 * for overdue invoices across every tenant, min 3 days between reminders.
 * Vercel cron: "0 7 * * *" (7 AM UTC daily)
 *
 * Previously called out to AGENTBOOK_INVOICE_URL (a pre-Next.js Express
 * microservice URL, defaulting to http://localhost:4052) with no auth guard
 * at all — unlike every other cron in this codebase. That service doesn't
 * exist in production, so every run 500'd and no reminder was ever recorded.
 * Fixed to query/update the DB directly, matching how every other cron here
 * works (e.g. recurring-invoices), and added the standard CRON_SECRET guard.
 *
 * Email delivery is a known, separately-tracked gap (see the single-invoice
 * /invoices/[id]/remind route's own docstring) — this only records the
 * reminder + bumps lastRemindedAt, same as that route does when a user
 * triggers a reminder manually.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REMINDER_COOLDOWN_DAYS = 3;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const cooldownCutoff = new Date(now.getTime() - REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    const overdue = await db.abInvoice.findMany({
      where: {
        status: { in: ['sent', 'viewed', 'overdue'] },
        dueDate: { lt: now },
        deletedAt: null,
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cooldownCutoff } }],
      },
      include: { payments: true },
      take: 200,
    });

    let sent = 0;
    for (const inv of overdue) {
      try {
        const totalPaid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
        const balance = inv.amountCents - totalPaid;
        const daysOverdue = Math.max(0, Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000));
        const tone = daysOverdue > 30 ? 'urgent' : daysOverdue > 14 ? 'firm' : 'gentle';

        await db.abInvoice.update({ where: { id: inv.id }, data: { lastRemindedAt: now } });
        await db.abEvent.create({
          data: {
            tenantId: inv.tenantId,
            eventType: 'invoice.reminder_sent',
            actor: 'system',
            action: { invoiceId: inv.id, tone, daysOverdue, balance, delivered: false, note: 'email send deferred; lastRemindedAt + audit event recorded (cron)' },
          },
        });
        sent++;
      } catch (err) {
        reportError(`[payment-reminders] invoice ${inv.id}`, err);
      }
    }

    return NextResponse.json({ success: true, data: { checked: overdue.length, sent } });
  } catch (err) {
    reportError('[payment-reminders] cron failed', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
