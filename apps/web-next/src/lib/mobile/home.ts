/**
 * GET /agentbook-core/mobile/home composer. Every number comes from the same
 * helper the desktop endpoint uses (dashboard metrics, AR aging, the tax
 * engine, the shared missing-receipt / doc-filter definitions); no HTTP
 * self-calls. Alerts carry `kind` + `params` (no English) and only mobile
 * destinations.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { getCashTodayCents, getMonthTotals, nonEmptyMonth, isBrandNewTenant } from '@/lib/agentbook-dashboard-metrics';
import { computeAgingReport, type AgingEntry } from '@/lib/agentbook-aging';
import { computeTaxEstimate, TAX_ESTIMATE_JURISDICTIONS } from '@/lib/agentbook-tax-estimate';
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import { docFilterWhere } from '@/lib/agentbook-expense-list-query';
import { defaultCurrencyFor } from '@/lib/jurisdiction-currency';
import { missingReceiptWhere, rankAlerts } from './alerts';
import { getUpcoming, daysBetweenUtc } from './upcoming';
import type { MobileAlert, MobileHome, RecentItem } from './types';

const DAY_MS = 86_400_000;
export const HOME_NEXT_UP_DAYS = 30;
export const TAX_ALERT_DAYS = 14;
export const BILL_ALERT_DAYS = 7;
const MAX_OVERDUE_ALERTS = 3;
const MAX_NEXT_UP = 3;
const MAX_RECENT = 5;

async function estimateOwed(tenantId: string, jurisdiction: string): Promise<number | null> {
  if (!TAX_ESTIMATE_JURISDICTIONS.includes(jurisdiction)) return null;
  try {
    return (await computeTaxEstimate(tenantId)).amountOwedCents;
  } catch (err) {
    console.warn('[mobile/home] tax estimate unavailable:', err);
    return null;
  }
}

/**
 * AI suggestions whose expense is still live and uncategorized (same freshness
 * rule as /auto-categorize/pending). Decoration: a failing lookup counts 0
 * rather than 500ing Home.
 */
async function freshSuggestionCount(tenantId: string): Promise<number> {
  const pending = await getPendingSuggestions(tenantId).catch((err) => {
    console.warn('[mobile/home] pending suggestions unavailable:', err instanceof Error ? err.message : err);
    return [];
  });
  if (pending.length === 0) return 0;
  return db.abExpense.count({
    where: { tenantId, id: { in: pending.map((p) => p.expenseId) }, categoryId: null, deletedAt: null },
  });
}

async function recentActivity(tenantId: string): Promise<RecentItem[]> {
  const [expenses, invoices, payments] = await Promise.all([
    db.abExpense.findMany({
      where: { tenantId, deletedAt: null, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECENT,
      include: { vendor: { select: { name: true } } },
    }),
    db.abInvoice.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECENT,
      include: { client: { select: { name: true } } },
    }),
    db.abPayment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECENT,
      include: { invoice: { select: { number: true, client: { select: { name: true } } } } },
    }),
  ]);
  const items: RecentItem[] = [
    ...expenses.map((e) => ({
      id: `expense:${e.id}`,
      kind: 'expense' as const,
      label: e.vendor?.name || e.description || '',
      amountCents: e.amountCents,
      at: e.createdAt.toISOString(),
      docId: e.id,
    })),
    ...invoices.map((i) => ({
      id: `invoice:${i.id}`,
      kind: 'invoice' as const,
      label: `${i.number} · ${i.client.name}`,
      amountCents: i.amountCents,
      at: i.createdAt.toISOString(),
    })),
    ...payments.map((p) => ({
      id: `payment:${p.id}`,
      kind: 'payment' as const,
      label: p.invoice ? `${p.invoice.number} · ${p.invoice.client.name}` : '',
      amountCents: p.amountCents,
      at: p.createdAt.toISOString(),
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_RECENT);
}

export async function buildMobileHome(tenantId: string, now: Date = new Date()): Promise<MobileHome> {
  const cfg = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { currency: true, jurisdiction: true },
  });
  const jurisdiction = cfg?.jurisdiction || 'us';

  const [
    cashTodayCents,
    months,
    isBrandNew,
    aging,
    estTaxOwedCents,
    upcoming,
    missingReceipts,
    uncategorized,
    needsReview,
    suggestions,
    dueBill,
    recent,
  ] = await Promise.all([
    getCashTodayCents(tenantId),
    getMonthTotals(tenantId, now),
    isBrandNewTenant(tenantId),
    computeAgingReport(tenantId, now),
    estimateOwed(tenantId, jurisdiction),
    getUpcoming(tenantId, HOME_NEXT_UP_DAYS, now),
    db.abExpense.count({ where: missingReceiptWhere(tenantId, now) }),
    db.abExpense.count({ where: docFilterWhere(tenantId, 'no-category') }),
    db.abExpense.count({ where: docFilterWhere(tenantId, 'needs-review') }),
    freshSuggestionCount(tenantId),
    db.abBill.findFirst({
      where: { tenantId, status: 'open', dueDate: { lte: new Date(now.getTime() + BILL_ALERT_DAYS * DAY_MS) } },
      orderBy: { dueDate: 'asc' },
    }),
    recentActivity(tenantId),
  ]);

  const overdue: AgingEntry[] = (Object.entries(aging.buckets) as [string, AgingEntry[]][])
    .filter(([bucket]) => bucket !== 'current')
    .flatMap(([, list]) => list)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const candidates: MobileAlert[] = [];
  for (const inv of overdue.slice(0, MAX_OVERDUE_ALERTS)) {
    candidates.push({
      id: `invoice_overdue:${inv.invoiceId}`,
      kind: 'invoice_overdue',
      severity: 'critical',
      params: { client: inv.clientName, days: inv.daysOverdue, amountCents: inv.balanceDueCents, number: inv.number },
      action: {
        type: 'post',
        endpoint: `/api/v1/agentbook-invoice/invoices/${inv.invoiceId}/remind`,
        labelKey: 'mobile.alerts.action_remind',
      },
    });
  }

  const tax = upcoming.find((u) => u.kind === 'tax' && u.daysAway <= TAX_ALERT_DAYS);
  if (tax) {
    candidates.push({
      id: `tax_deadline:${tax.id}`,
      kind: 'tax_deadline',
      severity: tax.daysAway <= 3 ? 'critical' : 'warn',
      params: {
        days: tax.daysAway,
        quarter: tax.params.quarter,
        year: tax.params.year,
        ...(tax.amountCents !== null ? { amountCents: tax.amountCents } : {}),
      },
      target: { route: '/app/chat', query: { topic: 'tax_deadline' } },
    });
  }

  if (dueBill) {
    const days = daysBetweenUtc(now, dueBill.dueDate);
    candidates.push({
      id: `bill_due:${dueBill.id}`,
      kind: 'bill_due',
      severity: days < 0 ? 'critical' : 'warn',
      params: { vendor: dueBill.vendorName, days, amountCents: dueBill.amountCents },
      target: { route: '/app/chat', query: { topic: 'bill_due' } },
    });
  }

  if (needsReview > 0 || suggestions > 0) {
    candidates.push({
      id: 'review_needed',
      kind: 'review_needed',
      severity: 'warn',
      params: { count: needsReview, suggestions },
      target: { route: '/app/docs', query: { filter: 'needs-review' } },
    });
  }

  if (missingReceipts > 0) {
    candidates.push({
      id: 'receipts_missing',
      kind: 'receipts_missing',
      severity: missingReceipts > 5 ? 'warn' : 'info',
      params: { count: missingReceipts },
      target: { route: '/app/docs', query: { filter: 'no-receipt' } },
    });
  }

  if (uncategorized > 0) {
    candidates.push({
      id: 'uncategorized',
      kind: 'uncategorized',
      severity: 'info',
      params: { count: uncategorized },
      target: { route: '/app/docs', query: { filter: 'no-category' } },
    });
  }

  return {
    currency: cfg?.currency || defaultCurrencyFor(jurisdiction),
    generatedAt: now.toISOString(),
    isBrandNew,
    kpis: {
      monthNetCents: nonEmptyMonth(months.monthMtd)?.netCents ?? null,
      cashTodayCents,
      outstandingCents: aging.totalOutstandingCents,
      overdueCount: overdue.length,
      overdueCents: overdue.reduce((s, e) => s + e.balanceDueCents, 0),
      estTaxOwedCents,
    },
    alerts: rankAlerts(candidates),
    nextUp: upcoming.slice(0, MAX_NEXT_UP),
    recent,
  };
}
