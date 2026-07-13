/**
 * Personal Finance Nudge Delivery Cron (PR-2 / Task 3b).
 *
 * Fires hourly but only *acts* once per tenant per day, at that tenant's
 * local morning hour — the same "hourly-triggered, self-gated to local
 * hour" pattern `morning-digest` uses, duplicated here rather than shared
 * (see the plan-level refinement in
 * docs/superpowers/plans/2026-07-12-personal-finance-trends-nudges.md:
 * folding this into morning-digest's own tenant-selection would silently
 * skip personal_insights subscribers who don't also have daily digest /
 * Telegram opted in, and would risk pulling them into the full digest
 * pipeline).
 *
 * Tenant selection is by active `personal_insights` BillAddOnSubscription,
 * not by digest opt-in. `BillAddOnSubscription.accountId` is used directly
 * as the personal-finance `tenantId` — `resolveAccountId()`
 * (packages/billing/src/account-resolver.ts) returns the tenantId
 * unchanged in v1, so accountId === tenantId today.
 *
 * Delivery mirrors `auto-categorize-watchdog`'s pattern (NOT
 * `proactive-alerts`, which only calls `sendToAllChannels`): every fired
 * nudge gets both a `createNotification()` (dashboard bell/inbox) and a
 * `sendToAllChannels()` call (Telegram/email/web). Dedup itself (has this
 * nudge already fired for this tenant/type/period/category?) lives entirely
 * in `checkPersonalFinanceNudges()` (Task 3a) via `AbPersonalNudgeLog` —
 * this route never writes to that table.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { checkPersonalFinanceNudges, type NudgeResult, type NudgeType } from '@/lib/agentbook-personal-nudges';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { createNotification, type NotificationCategory } from '@/lib/notifications';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// No per-tenant digest-style preference system exists for these nudges
// (unlike morning-digest's getDigestPrefs), so the target local hour is a
// fixed constant — mid-morning, distinct from morning-digest's 7am default
// so the two crons don't compete for the same minute of tenant attention.
const TARGET_LOCAL_HOUR = 9;

function categoryForNudgeType(nudgeType: NudgeType): NotificationCategory {
  switch (nudgeType) {
    case 'budget_alert_80':
    case 'budget_alert_100':
      return 'budget_alert';
    case 'net_worth_update':
      return 'net_worth_update';
    case 'savings_warning':
      return 'savings_warning';
  }
}

function severityForNudgeType(nudgeType: NudgeType): 'info' | 'warning' {
  switch (nudgeType) {
    case 'budget_alert_100':
    case 'savings_warning':
      return 'warning';
    case 'budget_alert_80':
    case 'net_worth_update':
      return 'info';
  }
}

function titleForNudge(result: NudgeResult): string {
  switch (result.nudgeType) {
    case 'budget_alert_80':
      return `${result.category || 'Budget'} — 80% used`;
    case 'budget_alert_100':
      return `${result.category || 'Budget'} — over limit`;
    case 'net_worth_update':
      return 'Net worth update';
    case 'savings_warning':
      return 'Spending exceeded income this month';
  }
}

async function deliverNudge(tenantId: string, result: NudgeResult): Promise<void> {
  // Telegram/email/web — best-effort, doesn't block the dashboard notification.
  try {
    await sendToAllChannels(tenantId, result.message);
  } catch (err) {
    void reportError(`[personal-finance-nudge-check] sendToAllChannels failed for tenant ${tenantId}`, err, {
      tenantId,
      source: 'cron/personal-finance-nudge-check',
    });
  }

  // Dashboard bell/inbox — same tolerance as auto-categorize-watchdog's
  // notification call, so a notification-write failure never re-fires the
  // Telegram send or crashes the tenant's whole loop iteration.
  try {
    await createNotification({
      category: categoryForNudgeType(result.nudgeType),
      severity: severityForNudgeType(result.nudgeType),
      title: titleForNudge(result),
      body: result.message,
      createdByType: 'system',
      createdBy: 'personal-finance-nudge-check-cron',
      audienceType: 'single',
      audienceFilter: { tenantId },
    });
  } catch (err) {
    void reportError(`[personal-finance-nudge-check] createNotification failed for tenant ${tenantId}`, err, {
      tenantId,
      source: 'cron/personal-finance-nudge-check',
    });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const subscriptions = await db.billAddOnSubscription.findMany({
    where: { status: 'active', addOn: { code: 'personal_insights', isActive: true } },
    select: { accountId: true },
  });

  const now = new Date();
  const targetParam = request.nextUrl.searchParams.get('hour');
  const bypass = targetParam === 'now';
  const targetHour = targetParam && !bypass ? parseInt(targetParam, 10) : TARGET_LOCAL_HOUR;

  let checked = 0;
  let skipped = 0;
  let nudgesFired = 0;
  let errors = 0;

  for (const { accountId } of subscriptions) {
    // accountId === tenantId today (resolveAccountId() is a no-op in v1) —
    // see the plan-level refinement note in the plan doc for why this
    // equivalence is stated explicitly rather than left implicit.
    const tenantId = accountId;
    try {
      const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
      const timezone = tenantConfig?.timezone || 'America/New_York';

      const fmtH = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone });
      const localHour = parseInt(fmtH.format(now), 10);

      if (!bypass && localHour !== targetHour) {
        skipped++;
        continue;
      }

      checked++;
      const results = await checkPersonalFinanceNudges(tenantId);
      for (const result of results) {
        await deliverNudge(tenantId, result);
        nudgesFired++;
      }
    } catch (err) {
      void reportError('[personal-finance-nudge-check] tenant error', err, {
        tenantId,
        source: 'cron/personal-finance-nudge-check',
      });
      errors++;
    }
  }

  return NextResponse.json({
    ok: true,
    checked,
    skipped,
    nudgesFired,
    errors,
    timestamp: new Date().toISOString(),
  });
}
