/**
 * AR aging — group outstanding invoices into 5 age buckets. Moved verbatim
 * from app/api/v1/agentbook-invoice/aging-report/route.ts; shared with the
 * mobile home KPIs (outstanding / overdue) so both read one definition.
 */
import 'server-only';
import { prisma as db } from '@naap/database';

export interface AgingEntry {
  invoiceId: string;
  number: string;
  clientId: string;
  clientName: string;
  amountCents: number;
  balanceDueCents: number;
  issuedDate: Date;
  dueDate: Date;
  daysOverdue: number;
}

export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

export interface AgingReport {
  buckets: Record<AgingBucket, AgingEntry[]>;
  totals: Record<AgingBucket, number>;
  totalOutstandingCents: number;
  asOfDate: string;
}

export async function computeAgingReport(tenantId: string, now: Date = new Date()): Promise<AgingReport> {
  const invoices = await db.abInvoice.findMany({
    where: { tenantId, status: { in: ['sent', 'viewed', 'overdue'] } },
    include: { payments: true, client: true },
  });

  const buckets: Record<AgingBucket, AgingEntry[]> = {
    current: [],
    '1-30': [],
    '31-60': [],
    '61-90': [],
    '90+': [],
  };
  const bucketTotals: Record<AgingBucket, number> = {
    current: 0,
    '1-30': 0,
    '31-60': 0,
    '61-90': 0,
    '90+': 0,
  };

  for (const inv of invoices) {
    const totalPaid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    const balanceDue = inv.amountCents - totalPaid;
    if (balanceDue <= 0) continue;

    const daysOverdue = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000);

    const entry: AgingEntry = {
      invoiceId: inv.id,
      number: inv.number,
      clientId: inv.clientId,
      clientName: inv.client.name,
      amountCents: inv.amountCents,
      balanceDueCents: balanceDue,
      issuedDate: inv.issuedDate,
      dueDate: inv.dueDate,
      daysOverdue: Math.max(0, daysOverdue),
    };

    let bucket: AgingBucket;
    if (daysOverdue <= 0) bucket = 'current';
    else if (daysOverdue <= 30) bucket = '1-30';
    else if (daysOverdue <= 60) bucket = '31-60';
    else if (daysOverdue <= 90) bucket = '61-90';
    else bucket = '90+';

    buckets[bucket].push(entry);
    bucketTotals[bucket] += balanceDue;
  }

  const totalOutstanding = Object.values(bucketTotals).reduce((s, v) => s + v, 0);

  return {
    buckets,
    totals: bucketTotals,
    totalOutstandingCents: totalOutstanding,
    asOfDate: now.toISOString(),
  };
}
