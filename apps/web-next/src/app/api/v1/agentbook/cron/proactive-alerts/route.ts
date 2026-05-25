/**
 * Proactive alerts cron (PR 13 / closes G-OLD-011).
 *
 * Vercel cron: "0 14 * * *" (daily 2pm UTC).
 *
 * Runs the proactive-alert generators inline (mirroring the logic at
 * plugins/agentbook-expense/backend/src/server.ts /advisor/proactive-alerts)
 * and dispatches important/critical alerts via Telegram to each tenant.
 *
 * Dedupe: an alert id (e.g. "missing-receipts", "spike-{categoryId}") is
 * sent at most once per 7 days per tenant. Prior sends are tracked via
 * AbEvent rows of type "proactive.alert_sent".
 *
 * Reads everything via direct Prisma — does NOT self-fetch over HTTP
 * (matches the pattern used by morning-digest).
 *
 * Bearer-gated when CRON_SECRET is set (timing-safe compare).
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ALERT_DEDUPE_DAYS = 7;
const ALERT_DEDUPE_MS = ALERT_DEDUPE_DAYS * 24 * 60 * 60 * 1000;

type Severity = 'critical' | 'important' | 'info';

interface Alert {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  message: string;
}

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Generate alerts for a single tenant. Mirrors the logic in the expense
 * plugin's /advisor/proactive-alerts endpoint. Kept self-contained so the
 * cron doesn't depend on the plugin port being reachable.
 */
async function generateAlertsForTenant(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);

  const alerts: Alert[] = [];

  // 1. Pending review items
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
    });
  }

  // 2. Missing receipts (business expenses > $25 in last 30 days)
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
    });
  }

  // 3. Unmatched bank transactions older than 7 days
  const unmatchedBank = await db.abBankTransaction.count({
    where: { tenantId, matchStatus: 'pending', date: { lte: sevenDaysAgo } },
  });
  if (unmatchedBank > 0) {
    alerts.push({
      id: 'unmatched-bank',
      type: 'reconciliation',
      severity: 'important',
      title: `${unmatchedBank} unmatched bank transaction${unmatchedBank > 1 ? 's' : ''}`,
      message: `${unmatchedBank} bank transaction${unmatchedBank > 1 ? 's are' : ' is'} older than 7 days and unmatched. These may be missing from your books.`,
    });
  }

  // 4. Spending-spike detection (category > 20% vs prior 30 days)
  const currentExpenses = await db.abExpense.findMany({
    where: { tenantId, isPersonal: false, status: 'confirmed', date: { gte: thirtyDaysAgo } },
    select: { categoryId: true, amountCents: true },
  });
  const priorExpenses = await db.abExpense.findMany({
    where: {
      tenantId,
      isPersonal: false,
      status: 'confirmed',
      date: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
    },
    select: { categoryId: true, amountCents: true },
  });

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
  const catRecords =
    catIds.length > 0
      ? await db.abAccount.findMany({ where: { id: { in: catIds }, tenantId } })
      : [];
  const catNameMap = Object.fromEntries(catRecords.map((c) => [c.id, c.name]));

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
        });
      }
    }
  }

  // 5. Uncategorized expenses (3+ in last 30 days)
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
    });
  }

  return alerts;
}

/**
 * Returns the set of alert ids that have been dispatched to this tenant
 * within the dedupe window. Read from AbEvent log so the dedup state is
 * durable + per-tenant.
 */
async function recentlySentAlertIds(tenantId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - ALERT_DEDUPE_MS);
  const events = await db.abEvent.findMany({
    where: {
      tenantId,
      eventType: 'proactive.alert_sent',
      createdAt: { gte: since },
    },
    select: { action: true },
  });
  const ids = new Set<string>();
  for (const e of events) {
    const alertId = (e.action as { alertId?: string } | null)?.alertId;
    if (alertId) ids.add(alertId);
  }
  return ids;
}

// PR 34 (Tier 5 #17): routes through the ChatAdapter abstraction. Future
// channels (WhatsApp / Discord / Slack) join by implementing ChatAdapter;
// this cron is unchanged.
async function notifyTenant(tenantId: string, message: string): Promise<boolean> {
  const results = await sendToAllChannels(tenantId, message, { plainText: true });
  return results.some((r) => r.delivered);
}

// PR 34: emit plain text — the ChatAdapter abstraction normalizes per
// channel; the cron stays channel-agnostic.
function formatAlert(alert: Alert): string {
  const severityIcon =
    alert.severity === 'critical' ? '🚨' : alert.severity === 'important' ? '⚠️' : 'ℹ️';
  return `${severityIcon} ${alert.title}\n${alert.message}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const tenants = await db.abTenantConfig.findMany({ select: { userId: true } });
    let tenantsProcessed = 0;
    let totalAlertsGenerated = 0;
    let totalAlertsSent = 0;
    let totalAlertsDedupSkipped = 0;
    let totalAlertsInfoSkipped = 0;

    for (const tenant of tenants) {
      const tenantId = tenant.userId;
      tenantsProcessed += 1;

      const alerts = await generateAlertsForTenant(tenantId);
      totalAlertsGenerated += alerts.length;
      if (alerts.length === 0) continue;

      const recentIds = await recentlySentAlertIds(tenantId);

      for (const alert of alerts) {
        // Only deliver important + critical via Telegram. Info-level
        // alerts surface only in the digest / dashboard.
        if (alert.severity === 'info') {
          totalAlertsInfoSkipped += 1;
          continue;
        }
        if (recentIds.has(alert.id)) {
          totalAlertsDedupSkipped += 1;
          continue;
        }

        const sent = await notifyTenant(tenantId, formatAlert(alert));
        if (sent) {
          totalAlertsSent += 1;
          await db.abEvent.create({
            data: {
              tenantId,
              eventType: 'proactive.alert_sent',
              actor: 'system',
              action: {
                alertId: alert.id,
                type: alert.type,
                severity: alert.severity,
                title: alert.title,
              },
            },
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        tenantsProcessed,
        totalAlertsGenerated,
        totalAlertsSent,
        totalAlertsDedupSkipped,
        totalAlertsInfoSkipped,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    void reportError('cron/proactive-alerts failed', err, { source: 'cron/proactive-alerts' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
