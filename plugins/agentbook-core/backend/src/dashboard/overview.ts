/**
 * Dashboard /overview aggregator.
 *
 * Fans out to existing tax/invoice/expense endpoints, ranks the
 * attention queue, builds the "next moments" list, derives a mood label,
 * and returns one payload to the client.
 *
 * Partial failures: any leaf endpoint failure becomes `null` for its
 * slice — the page still renders the rest.
 */

import type { Request, Response } from 'express';
import { db } from '../db/client.js';
import { detectRecurringForTenant, type RecurringOutflow } from './recurring-detector.js';

// === Types =================================================================

export interface NextMoment {
  kind: 'income' | 'tax' | 'rent' | 'recurring';
  label: string;
  amountCents: number;
  daysOut: number;
  sourceId?: string;
}

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  subtitle?: string;
  amountCents?: number;
  action?: { label: string; href?: string; postEndpoint?: string };
}

export interface OverviewPayload {
  cashToday: number;
  projection: {
    days: { date: string; cents: number }[];
    moodLabel: 'healthy' | 'tight' | 'critical';
  } | null;
  nextMoments: NextMoment[];
  attention: AttentionItem[];
  recurringOutflows: RecurringOutflow[];
  monthMtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  monthPrev: { revenueCents: number; expenseCents: number; netCents: number } | null;
  isBrandNew: boolean;
}

// === Pure helpers (unit-tested) ============================================

interface AttentionInput {
  overdue: { id: string; client: string; daysOverdue: number; amountCents: number }[];
  taxQuarterly: { dueDate: string; amountCents: number; daysOut: number } | null;
  unbilled: { hours: number; amountCents: number } | null;
  booksOutOfBalance: boolean;
  missingReceiptsCount: number;
}

export function rankAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Cap overdue at 4 so other high-signal callouts (tax, unbilled, etc.)
  // still surface within the 5-item attention list.
  for (const ov of input.overdue.slice(0, 4)) {
    items.push({
      id: `overdue:${ov.id}`,
      severity: 'critical',
      title: `${ov.client} · ${ov.daysOverdue} days overdue`,
      amountCents: ov.amountCents,
      action: { label: 'Send reminder', postEndpoint: `/api/v1/agentbook-invoice/invoices/${ov.id}/remind` },
    });
  }

  if (input.taxQuarterly && input.taxQuarterly.daysOut <= 14) {
    items.push({
      id: 'tax',
      severity: 'warn',
      title: `Tax payment due ${input.taxQuarterly.dueDate}`,
      amountCents: input.taxQuarterly.amountCents,
      action: { label: 'View', href: '/agentbook/tax' },
    });
  }

  if (input.unbilled && input.unbilled.hours > 0) {
    items.push({
      id: 'unbilled',
      severity: 'info',
      title: `${input.unbilled.hours.toFixed(1)} unbilled hours`,
      amountCents: input.unbilled.amountCents,
      action: { label: 'Invoice now', href: '/agentbook/invoices/new' },
    });
  }

  if (input.booksOutOfBalance) {
    items.push({
      id: 'balance',
      severity: 'critical',
      title: 'Books are out of balance',
      action: { label: 'Review', href: '/agentbook/ledger' },
    });
  }

  if (input.missingReceiptsCount >= 3) {
    items.push({
      id: 'receipts',
      severity: 'info',
      title: `${input.missingReceiptsCount} expenses missing receipts`,
      action: { label: 'Upload', href: '/agentbook/expenses' },
    });
  }

  return items.slice(0, 5);
}

interface NextMomentsInput {
  upcomingInvoices: { client: string; amountCents: number; daysOut: number; sourceId?: string }[];
  tax: { amountCents: number; daysOut: number } | null;
  recurring: { vendor: string; amountCents: number; daysOut: number }[];
}

export function buildNextMoments(input: NextMomentsInput): NextMoment[] {
  const moments: NextMoment[] = [];

  for (const inv of input.upcomingInvoices) {
    moments.push({
      kind: 'income',
      label: `💰 ${inv.client} $${(inv.amountCents / 100).toFixed(0)} in ${inv.daysOut}d`,
      amountCents: inv.amountCents,
      daysOut: inv.daysOut,
      sourceId: inv.sourceId,
    });
  }

  if (input.tax) {
    moments.push({
      kind: 'tax',
      label: `📋 Tax $${(input.tax.amountCents / 100).toFixed(0)} in ${input.tax.daysOut}d`,
      amountCents: input.tax.amountCents,
      daysOut: input.tax.daysOut,
    });
  }

  for (const r of input.recurring) {
    const isRent = /rent|lease/i.test(r.vendor);
    moments.push({
      kind: isRent ? 'rent' : 'recurring',
      label: `${isRent ? '🏠' : '🔁'} ${r.vendor} $${(r.amountCents / 100).toFixed(0)} in ${r.daysOut}d`,
      amountCents: r.amountCents,
      daysOut: r.daysOut,
    });
  }

  moments.sort((a, b) => {
    if (a.daysOut !== b.daysOut) return a.daysOut - b.daysOut;
    return Math.abs(b.amountCents) - Math.abs(a.amountCents);
  });

  return moments.slice(0, 4);
}

export function deriveMoodLabel(
  days: { cents: number }[],
  monthlyExpenseRunRateCents: number
): 'healthy' | 'tight' | 'critical' {
  if (days.length === 0) return 'healthy';
  const minCents = Math.min(...days.map(d => d.cents));
  if (minCents <= 0) return 'critical';
  if (monthlyExpenseRunRateCents > 0 && minCents < 0.5 * monthlyExpenseRunRateCents) return 'tight';
  return 'healthy';
}

// === Express handler =======================================================

const TAX_BASE = process.env.AGENTBOOK_TAX_URL || 'http://localhost:4053';
const INVOICE_BASE = process.env.AGENTBOOK_INVOICE_URL || 'http://localhost:4052';
const EXPENSE_BASE = process.env.AGENTBOOK_EXPENSE_URL || 'http://localhost:4051';
const CORE_BASE = process.env.AGENTBOOK_CORE_URL || `http://localhost:${process.env.PORT || '4050'}`;

interface FetchOpts {
  url: string;
  tenantId: string;
}

async function safeJson<T>({ url, tenantId }: FetchOpts): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data ?? json) as T;
  } catch (err) {
    console.error('[overview] leaf fetch failed', url, err);
    return null;
  }
}

export async function handleDashboardOverview(req: Request, res: Response): Promise<void> {
  const tenantId: string = (req as any).tenantId;
  const today = new Date();

  const [
    trialBalance,
    projection,
    upcomingInvoices,
    overdueAging,
    quarterlyTax,
    unbilled,
    missingReceipts,
    pnlMtd,
    pnlPrev,
    expenseCount,
    invoiceCount,
  ] = await Promise.all([
    safeJson<{ totalDebits: number; totalCredits: number; balanced: boolean; accounts: { accountType: string; balance: number }[] }>(
      { url: `${CORE_BASE}/api/v1/agentbook-core/trial-balance`, tenantId }
    ),
    safeJson<{ days: { date: string; cents: number }[] }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/cashflow/projection`, tenantId }
    ),
    safeJson<{ id: string; client: { name: string }; total: number; dueDate: string }[]>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/invoices?status=sent&dueWithinDays=30`, tenantId }
    ),
    safeJson<{ buckets: any; overdueInvoices: { id: string; client: string; daysOverdue: number; amountCents: number }[] }>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/aging-report`, tenantId }
    ),
    safeJson<{ year: number; quarters: { quarter: number; dueDate: string; estimatedCents: number; paid: boolean }[] }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/tax/quarterly`, tenantId }
    ),
    safeJson<{ totalHours: number; totalCents: number }>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/unbilled-summary`, tenantId }
    ),
    safeJson<{ count: number }>(
      { url: `${EXPENSE_BASE}/api/v1/agentbook-expense/expenses?missingReceipt=true&limit=1&countOnly=true`, tenantId }
    ),
    safeJson<{ revenueCents: number; expenseCents: number; netCents: number }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/reports/pnl?period=mtd`, tenantId }
    ),
    safeJson<{ revenueCents: number; expenseCents: number; netCents: number }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/reports/pnl?period=last-month`, tenantId }
    ),
    db.abExpense.count({ where: { tenantId } }),
    db.abInvoice.count({ where: { tenantId } }),
  ]);

  const cashToday = trialBalance
    ? trialBalance.accounts.filter(a => a.accountType === 'asset').reduce((s, a) => s + (a.balance || 0), 0)
    : 0;

  const recurring = await detectRecurringForTenant(tenantId, today);
  const recurringWithDays = recurring.map(r => ({
    ...r,
    daysOut: Math.max(0, Math.round((new Date(r.nextExpectedDate).getTime() - today.getTime()) / 86400000)),
  }));

  const nextTax = quarterlyTax?.quarters.find(q => !q.paid && new Date(q.dueDate) >= today);
  const taxDaysOut = nextTax
    ? Math.round((new Date(nextTax.dueDate).getTime() - today.getTime()) / 86400000)
    : null;

  const nextMoments = buildNextMoments({
    upcomingInvoices: (upcomingInvoices || []).map((i: any) => ({
      client: i.client?.name || 'Client',
      amountCents: Math.round((i.total || 0) * 100),
      daysOut: Math.max(0, Math.round((new Date(i.dueDate).getTime() - today.getTime()) / 86400000)),
      sourceId: i.id,
    })),
    tax: nextTax && taxDaysOut !== null ? { amountCents: nextTax.estimatedCents, daysOut: taxDaysOut } : null,
    recurring: recurringWithDays.filter(r => r.daysOut <= 30).map(r => ({
      vendor: r.vendor, amountCents: r.amountCents, daysOut: r.daysOut,
    })),
  });

  const attention = rankAttention({
    overdue: overdueAging?.overdueInvoices || [],
    taxQuarterly: nextTax && taxDaysOut !== null
      ? { dueDate: nextTax.dueDate.slice(0, 10), amountCents: nextTax.estimatedCents, daysOut: taxDaysOut }
      : null,
    unbilled: unbilled && unbilled.totalHours > 0
      ? { hours: unbilled.totalHours, amountCents: unbilled.totalCents }
      : null,
    booksOutOfBalance: trialBalance ? !trialBalance.balanced : false,
    missingReceiptsCount: missingReceipts?.count || 0,
  });

  const monthlyBurn = pnlMtd?.expenseCents || 0;
  const moodLabel = projection ? deriveMoodLabel(projection.days, monthlyBurn) : 'healthy';

  const payload: OverviewPayload = {
    cashToday,
    projection: projection ? { days: projection.days, moodLabel } : null,
    nextMoments,
    attention,
    recurringOutflows: recurring,
    monthMtd: pnlMtd,
    monthPrev: pnlPrev,
    isBrandNew: expenseCount === 0 && invoiceCount === 0,
  };

  res.json({ success: true, data: payload });
}
