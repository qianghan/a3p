/**
 * Proactive alerts — six alert types: pending review, missing receipts,
 * unmatched bank transactions, spending spikes vs last 30 days, piles of
 * uncategorized expenses, and (AU only) the GST registration threshold.
 * Sorted by severity.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { formatCents } from '@/lib/agentbook-advisor';
import { publicErrorMessage } from '@/lib/api-error';
import { checkGstThreshold, gstStatusOf } from '@agentbook/jurisdictions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Alert {
  id: string;
  type: string;
  severity: 'critical' | 'important' | 'info';
  title: string;
  message: string;
  action?: { label: string; type: string; url: string };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

    const alerts: Alert[] = [];

    const pendingCount = await db.abExpense.count({
      where: { tenantId, status: 'pending_review' },
    });
    if (pendingCount > 0) {
      alerts.push({
        id: 'pending-review',
        type: 'review_needed',
        severity: 'important',
        title: `${pendingCount} expense${pendingCount > 1 ? 's' : ''} need${pendingCount === 1 ? 's' : ''} review`,
        message: `You have ${pendingCount} unconfirmed expense${pendingCount > 1 ? 's' : ''}. Review them to keep your books accurate.`,
        action: { label: 'Review Now', type: 'navigate', url: '/agentbook/expenses?filter=pending_review' },
      });
    }

    const missingReceipts = await db.abExpense.count({
      where: {
        tenantId,
        isPersonal: false,
        status: 'confirmed',
        receiptUrl: null,
        amountCents: { gt: 2500 },
        date: { gte: thirtyDaysAgo },
      },
    });
    if (missingReceipts > 0) {
      alerts.push({
        id: 'missing-receipts',
        type: 'missing_receipt',
        severity: missingReceipts > 5 ? 'important' : 'info',
        title: `${missingReceipts} receipt${missingReceipts > 1 ? 's' : ''} missing`,
        message: `${missingReceipts} business expense${missingReceipts > 1 ? 's' : ''} over $25 without receipt. Snap photos before they fade!`,
        action: { label: 'View Expenses', type: 'navigate', url: '/agentbook/expenses' },
      });
    }

    const unmatchedBank = await db.abBankTransaction.count({
      where: { tenantId, matchStatus: 'pending', date: { lte: sevenDaysAgo } },
    });
    if (unmatchedBank > 0) {
      alerts.push({
        id: 'unmatched-bank',
        type: 'reconciliation',
        severity: 'important',
        title: `${unmatchedBank} unmatched bank transaction${unmatchedBank > 1 ? 's' : ''}`,
        message: `${unmatchedBank} bank transaction${unmatchedBank > 1 ? 's are' : ' is'} older than 7 days and not matched to any expense.`,
        action: { label: 'Reconcile', type: 'navigate', url: '/agentbook/bank' },
      });
    }

    const [currentExpenses, priorExpenses] = await Promise.all([
      db.abExpense.findMany({
        where: { tenantId, isPersonal: false, status: 'confirmed', date: { gte: thirtyDaysAgo } },
      }),
      db.abExpense.findMany({
        where: { tenantId, isPersonal: false, status: 'confirmed', date: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
      }),
    ]);

    const currentByCat: Record<string, number> = {};
    const priorByCat: Record<string, number> = {};
    for (const e of currentExpenses) {
      const k = e.categoryId || 'other';
      currentByCat[k] = (currentByCat[k] || 0) + e.amountCents;
    }
    for (const e of priorExpenses) {
      const k = e.categoryId || 'other';
      priorByCat[k] = (priorByCat[k] || 0) + e.amountCents;
    }

    const catIds = [
      ...new Set([...Object.keys(currentByCat), ...Object.keys(priorByCat)].filter((k) => k !== 'other')),
    ];
    const catNames = catIds.length > 0
      ? await db.abAccount.findMany({ where: { id: { in: catIds } } })
      : [];
    const catNameMap = Object.fromEntries(catNames.map((c) => [c.id, c.name]));

    for (const [catId, current] of Object.entries(currentByCat)) {
      const prior = priorByCat[catId] || 0;
      if (prior > 0) {
        const pct = Math.round(((current - prior) / prior) * 100);
        if (pct > 20) {
          alerts.push({
            id: `spike-${catId}`,
            type: 'spending_spike',
            severity: pct > 50 ? 'critical' : 'important',
            title: `${catNameMap[catId] || 'Spending'} up ${pct}%`,
            message: `${catNameMap[catId] || 'Category'}: ${formatCents(current)} this month vs ${formatCents(prior)} last month (+${pct}%).`,
            action: { label: 'View Details', type: 'navigate', url: '/agentbook/expenses' },
          });
        }
      }
    }

    const uncategorized = await db.abExpense.count({
      where: {
        tenantId,
        categoryId: null,
        isPersonal: false,
        status: 'confirmed',
        date: { gte: thirtyDaysAgo },
      },
    });
    if (uncategorized > 3) {
      alerts.push({
        id: 'uncategorized',
        type: 'uncategorized',
        severity: 'info',
        title: `${uncategorized} uncategorized expenses`,
        message: 'Categorize them for accurate tax reporting and spending insights.',
        action: { label: 'Categorize', type: 'navigate', url: '/agentbook/expenses' },
      });
    }

    // ── AU GST registration threshold ────────────────────────────────
    // Rolling twelve months, not the financial year: the ATO measures GST
    // turnover over any twelve-month window, so a June-to-May run over
    // A$75,000 creates the obligation even though no income year did.
    const cfg = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { jurisdiction: true, gstRegistered: true },
    });
    if (cfg?.jurisdiction === 'au') {
      const twelveMonthsAgo = new Date(now.getTime() - 365 * 86_400_000);
      // Turnover is what was BILLED, so it counts issued invoices rather than
      // payments received — a business on accruals crosses the threshold when
      // it invoices, not when the client eventually pays.
      const turnover = await db.abInvoice.aggregate({
        where: {
          tenantId,
          status: { notIn: ['draft', 'void', 'cancelled'] },
          issuedDate: { gte: twelveMonthsAgo },
        },
        _sum: { amountCents: true, taxCents: true },
      });
      // GST turnover EXCLUDES the GST itself, so net it off rather than
      // counting our own 10% toward the threshold that decides whether we
      // should have charged it.
      const turnoverCents = (turnover._sum.amountCents ?? 0) - (turnover._sum.taxCents ?? 0);
      const check = checkGstThreshold(turnoverCents, gstStatusOf(cfg.gstRegistered));
      if (check.advice) {
        alerts.push({
          id: 'au-gst-threshold',
          type: 'gst_registration',
          severity: check.advice.severity === 'action' ? 'critical' : 'important',
          title: check.overThreshold
            ? 'GST registration is now compulsory'
            : 'Are you registered for GST?',
          message: check.advice.message,
          action: { label: 'Open Settings', type: 'navigate', url: '/agentbook/settings' },
        });
      }
    }

    const severityOrder: Record<string, number> = { critical: 0, important: 1, info: 2 };
    alerts.sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9));

    return NextResponse.json({
      success: true,
      data: { alerts, generatedAt: now.toISOString() },
    });
  } catch (err) {
    console.error('[agentbook-expense/advisor/proactive-alerts] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
