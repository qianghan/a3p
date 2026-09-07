/**
 * Home-office quarterly prompt cron (PR 15).
 *
 * Vercel cron: "0 13 * * *" (daily 1pm UTC). Fires every day so the
 * scheduling stays simple, but only sends a Telegram message on the
 * first day of the calendar quarter (Jan 1 / Apr 1 / Jul 1 / Oct 1).
 * Other days are no-ops — gated by a date check inside the handler.
 *
 * Bearer-gated when `CRON_SECRET` is set (timing-safe compare).
 *
 * Per-tenant message:
 *   "🏠 Q{N} home office time. Reply with this quarter's totals:
 *    utilities, internet, rent/mortgage interest, insurance."
 *
 * The quarter referenced is the one that just ended — i.e. on Apr 1
 * we ask about Q1 totals so the user can post-quarter for Q1.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { reportError } from '@/lib/logger';
import { requireCronSecret } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;


/**
 * On Jan 1 we ask about the Q4 just ended (last year). On Apr 1 → Q1.
 * On Jul 1 → Q2. On Oct 1 → Q3. Returns null when today isn't a
 * quarter-start date.
 */
export function quarterTriggerForDate(now: Date): { year: number; quarter: number } | null {
  const day = now.getUTCDate();
  if (day !== 1) return null;
  const month = now.getUTCMonth();          // 0-11
  const yearNow = now.getUTCFullYear();
  switch (month) {
    case 0:  return { year: yearNow - 1, quarter: 4 };
    case 3:  return { year: yearNow,     quarter: 1 };
    case 6:  return { year: yearNow,     quarter: 2 };
    case 9:  return { year: yearNow,     quarter: 3 };
    default: return null;
  }
}

// PR 34 (Tier 5 #17): delivery routes through the ChatAdapter abstraction
// so future platforms (WhatsApp, Discord, Slack) plug in without touching
// this cron. Returns true if at least one channel delivered.
async function notifyTenant(tenantId: string, message: string): Promise<boolean> {
  const results = await sendToAllChannels(tenantId, message, { plainText: true });
  return results.some((r) => r.delivered);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const now = new Date();
  const trigger = quarterTriggerForDate(now);
  if (!trigger) {
    // Not a quarter-start day — quiet no-op so the cron stays cheap.
    return NextResponse.json({
      success: true,
      data: { triggered: false, reason: 'not a quarter-start day' },
    });
  }

  try {
    const tenants = await db.abTenantConfig.findMany();
    let prompted = 0;
    let skipped = 0;
    const message =
      `🏠 Q${trigger.quarter} home office time. Reply with this quarter's totals: ` +
      `utilities, internet, rent/mortgage interest, insurance.`;

    for (const tenant of tenants) {
      const cfg = await db.abHomeOfficeConfig.findUnique({
        where: { tenantId: tenant.userId },
      });
      // No config? Still nudge — the user might want to set it up. We
      // tag the event so analytics can see the conversion.
      const sent = await notifyTenant(tenant.userId, message);
      if (sent) {
        prompted += 1;
        await db.abEvent.create({
          data: {
            tenantId: tenant.userId,
            eventType: 'home_office.quarterly_prompt',
            actor: 'system',
            action: {
              year: trigger.year,
              quarter: trigger.quarter,
              hasConfig: !!cfg,
              useUsSimplified: !!cfg?.useUsSimplified,
            },
          },
        });
      } else {
        skipped += 1;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        triggered: true,
        year: trigger.year,
        quarter: trigger.quarter,
        tenants: tenants.length,
        prompted,
        skipped,
      },
    });
  } catch (err) {
    void reportError('cron/home-office-quarterly failed', err, { source: 'cron/home-office-quarterly' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
