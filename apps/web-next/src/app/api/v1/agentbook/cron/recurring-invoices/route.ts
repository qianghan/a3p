/**
 * Recurring Invoice Cron — Auto-generates invoices from recurring schedules.
 * Vercel cron: "0 6 * * *" (6 AM UTC daily)
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { reportError } from '@/lib/logger';
import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ── Overdue sweep ──────────────────────────────────────────────────────────
    const swept = await db.abInvoice.updateMany({
      where: {
        status: { in: ['sent', 'viewed'] },
        dueDate: { lt: new Date() },
        deletedAt: null,
      },
      data: { status: 'overdue' },
    });
    if (swept.count > 0) {
      console.log(`[cron] Marked ${swept.count} invoice(s) as overdue`);
    }

    const now = new Date();
    const dueItems = await db.abRecurringInvoice.findMany({
      where: { status: 'active', nextDue: { lte: now } },
    });

    let generated = 0;

    for (const item of dueItems) {
      // Check end date
      if (item.endDate && now > item.endDate) {
        await db.abRecurringInvoice.update({ where: { id: item.id }, data: { status: 'completed' } });
        continue;
      }

      const client = await db.abClient.findFirst({ where: { id: item.clientId, tenantId: item.tenantId } });
      if (!client) continue;

      // Generate invoice number
      const year = now.getFullYear();
      const lastInvoice = await db.abInvoice.findFirst({
        where: { tenantId: item.tenantId, number: { startsWith: `INV-${year}-` } },
        orderBy: { number: 'desc' },
      });
      let nextSeq = 1;
      if (lastInvoice) nextSeq = parseInt(lastInvoice.number.split('-')[2], 10) + 1;
      const invoiceNumber = `INV-${year}-${String(nextSeq).padStart(4, '0')}`;

      const lines = (item.templateLines as any[]).map((l: any) => ({
        tenantId: item.tenantId, // G-009
        description: l.description,
        quantity: l.quantity || 1,
        rateCents: l.rateCents,
        amountCents: Math.round((l.quantity || 1) * l.rateCents),
      }));

      const subtotalCents = item.totalCents;
      const taxResult = await computeInvoiceTax(item.tenantId, subtotalCents);
      const grandTotalCents = subtotalCents + taxResult.taxCents;

      // Look up accounts
      const requiredLiabilityCodes = [...new Set(taxResult.components.map((c) => c.accountCode))];
      const [arAccount, revenueAccount, liabilityAccounts] = await Promise.all([
        db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '1100' } }),
        db.abAccount.findFirst({ where: { tenantId: item.tenantId, code: '4000' } }),
        requiredLiabilityCodes.length > 0
          ? db.abAccount.findMany({ where: { tenantId: item.tenantId, code: { in: requiredLiabilityCodes } } })
          : Promise.resolve([]),
      ]);
      if (!arAccount || !revenueAccount) continue;
      const liabilityAccountsByCode = new Map(liabilityAccounts.map((a) => [a.code, a]));
      if (requiredLiabilityCodes.some((code) => !liabilityAccountsByCode.has(code))) {
        // Best-effort cron: skip this item rather than crash the whole
        // batch. Logged so a missing chart-of-accounts seed is visible.
        console.warn(`[cron/recurring-invoices] skipping ${item.id}: missing tax liability account`);
        continue;
      }

      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + item.daysToPay);

      await db.$transaction(async (tx) => {
        const journalLines = [
          { tenantId: item.tenantId, accountId: arAccount.id, debitCents: grandTotalCents, creditCents: 0, description: `AR - ${invoiceNumber}` }, // G-009
          { tenantId: item.tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: subtotalCents, description: `Revenue - ${invoiceNumber}` }, // G-009
          ...taxResult.components.map((c) => ({
            tenantId: item.tenantId, // G-009
            accountId: liabilityAccountsByCode.get(c.accountCode)!.id,
            debitCents: 0,
            creditCents: c.amountCents,
            description: `${c.type} Payable - ${invoiceNumber}`,
          })),
        ];

        const je = await tx.abJournalEntry.create({
          data: {
            tenantId: item.tenantId, date: now,
            memo: `Recurring Invoice ${invoiceNumber} to ${client.name}`,
            sourceType: 'invoice', verified: true,
            lines: { create: journalLines },
          },
        });

        const inv = await tx.abInvoice.create({
          data: {
            tenantId: item.tenantId, clientId: item.clientId, number: invoiceNumber,
            amountCents: grandTotalCents,
            taxRate: taxResult.taxRate || null,
            taxCents: taxResult.taxCents,
            currency: item.currency,
            issuedDate: now, dueDate,
            status: item.autoSend ? 'sent' : 'draft',
            source: 'recurring',
            journalEntryId: je.id, recurringId: item.id,
            lines: { create: lines },
          },
        });

        await tx.abJournalEntry.update({ where: { id: je.id }, data: { sourceId: inv.id } });
        await tx.abClient.update({ where: { id: item.clientId }, data: { totalBilledCents: { increment: grandTotalCents } } });

        if (taxResult.components.length > 0) {
          const taxTenantConfig = await tx.abTenantConfig.findUnique({
            where: { userId: item.tenantId },
            select: { jurisdiction: true, region: true },
          });
          await tx.abSalesTaxCollected.createMany({
            data: taxResult.components.map((c) => ({
              tenantId: item.tenantId,
              invoiceId: inv.id,
              jurisdiction: taxTenantConfig?.jurisdiction || 'us',
              region: taxTenantConfig?.region || '',
              taxType: c.type,
              rate: c.rate,
              amountCents: c.amountCents,
            })),
          });
        }

        await tx.abEvent.create({
          data: {
            tenantId: item.tenantId, eventType: 'invoice.auto_generated', actor: 'system',
            action: { invoiceId: inv.id, number: invoiceNumber, recurringId: item.id, amountCents: grandTotalCents, taxCents: taxResult.taxCents },
          },
        });
      });

      // Advance next due date
      const nextDue = new Date(item.nextDue);
      switch (item.frequency) {
        case 'weekly': nextDue.setDate(nextDue.getDate() + 7); break;
        case 'biweekly': nextDue.setDate(nextDue.getDate() + 14); break;
        case 'monthly': nextDue.setMonth(nextDue.getMonth() + 1); break;
        case 'quarterly': nextDue.setMonth(nextDue.getMonth() + 3); break;
        case 'annual': nextDue.setFullYear(nextDue.getFullYear() + 1); break;
      }

      await db.abRecurringInvoice.update({
        where: { id: item.id },
        data: { nextDue, lastGenerated: now, generatedCount: { increment: 1 } },
      });

      generated++;
    }

    return NextResponse.json({ success: true, generated, checked: dueItems.length, timestamp: now.toISOString() });
  } catch (err) {
    void reportError('cron/recurring-invoices failed', err, { source: 'cron/recurring-invoices' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
