/**
 * Weekly Review Cron — Sends weekly financial summary on Mondays.
 * Vercel cron: "0 14 * * 1" (2 PM UTC Monday)
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { reportError } from '@/lib/logger';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';


export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let processed = 0;
    let delivered = 0;

    const tenants = await db.abTenantConfig.findMany();

    for (const tenant of tenants) {
      const tenantId = tenant.userId;

      // Aggregate weekly expenses
      const weeklyExpenses = await db.abExpense.aggregate({
        where: { tenantId, date: { gte: weekAgo }, isPersonal: false },
        _sum: { amountCents: true },
        _count: true,
      });

      // Aggregate weekly invoices created
      const weeklyInvoices = await db.abInvoice.aggregate({
        where: { tenantId, issuedDate: { gte: weekAgo } },
        _sum: { amountCents: true },
        _count: true,
      });

      // Aggregate weekly payments received
      const weeklyPayments = await db.abPayment.aggregate({
        where: { tenantId, date: { gte: weekAgo } },
        _sum: { amountCents: true },
        _count: true,
      });

      // Count overdue invoices
      const overdueCount = await db.abInvoice.count({
        where: { tenantId, status: { in: ['sent', 'viewed', 'overdue'] }, dueDate: { lt: now } },
      });

      // Missing receipts this week
      const missingReceipts = await db.abExpense.count({
        where: { tenantId, receiptUrl: null, date: { gte: weekAgo } },
      });

      const expensesCents = weeklyExpenses._sum.amountCents || 0;
      const expenseCount = weeklyExpenses._count || 0;
      const invoicedCents = weeklyInvoices._sum.amountCents || 0;
      const invoiceCount = weeklyInvoices._count || 0;
      const paymentsCents = weeklyPayments._sum.amountCents || 0;
      const paymentCount = weeklyPayments._count || 0;

      // Emit weekly review event (history / proactive engine).
      await db.abEvent.create({
        data: {
          tenantId,
          eventType: 'proactive.weekly_review',
          actor: 'system',
          action: {
            period_start: weekAgo.toISOString(),
            period_end: now.toISOString(),
            expenses_cents: expensesCents,
            expense_count: expenseCount,
            invoiced_cents: invoicedCents,
            invoice_count: invoiceCount,
            payments_cents: paymentsCents,
            payment_count: paymentCount,
            overdue_invoices: overdueCount,
            missing_receipts: missingReceipts,
          },
        },
      });

      // Actually SEND the summary — this is what makes it a "weekly review"
      // rather than a stored-and-forgotten event. Fan out to every channel the
      // tenant has (Telegram / email / …). Skip weeks with no activity so we
      // never spam an inactive tenant. Best-effort per tenant.
      const hasActivity = expenseCount > 0 || invoiceCount > 0 || paymentCount > 0 || overdueCount > 0 || missingReceipts > 0;
      if (hasActivity) {
        const cur = tenant.currency || 'USD';
        const fmt = (c: number) => formatCurrencyCents(c, cur);
        const lines = [
          '📊 Your week in review',
          '',
          `💸 Expenses: ${expenseCount} logged, ${fmt(expensesCents)}`,
          `🧾 Invoiced: ${invoiceCount} sent, ${fmt(invoicedCents)}`,
          `💰 Payments in: ${paymentCount}, ${fmt(paymentsCents)}`,
        ];
        if (overdueCount > 0) lines.push(`⚠️ ${overdueCount} overdue invoice${overdueCount > 1 ? 's' : ''} — want me to send reminders?`);
        if (missingReceipts > 0) lines.push(`📎 ${missingReceipts} expense${missingReceipts > 1 ? 's' : ''} still need a receipt`);
        try {
          await sendToAllChannels(tenantId, lines.join('\n'));
          delivered++;
        } catch (deliverErr) {
          void reportError('cron/weekly-review delivery failed', deliverErr, { source: 'cron/weekly-review', tenantId });
        }
      }

      processed++;
    }

    return NextResponse.json({
      success: true,
      processed,
      delivered,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    void reportError('cron/weekly-review failed', err, { source: 'cron/weekly-review' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
