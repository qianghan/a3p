/**
 * Proactive alerts — five alert types: pending review, missing receipts,
 * unmatched bank transactions, spending spikes vs last 30 days, and
 * piles of uncategorized expenses. Sorted by severity.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { formatCents } from '@/lib/agentbook-advisor';

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
    const tenantId = await resolveAgentbookTenant(request);
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

    const severityOrder: Record<string, number> = { critical: 0, important: 1, info: 2 };
    alerts.sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9));

    return NextResponse.json({
      success: true,
      data: { alerts, generatedAt: now.toISOString() },
    });
  } catch (err) {
    console.error('[agentbook-expense/advisor/proactive-alerts] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
