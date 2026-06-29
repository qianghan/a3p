import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isBearerValid(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev mode
  const auth = request.headers.get('authorization');
  if (!auth) return false;
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${cronSecret}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isBearerValid(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Get all unique tenantIds that have at least 1 expense
  const tenantRows = await db.abExpense.groupBy({ by: ['tenantId'] });

  const results: Array<{ tenantId: string; action: string }> = [];

  for (const { tenantId } of tenantRows) {
    try {
      // Check threshold before running
      const [total, uncategorized] = await Promise.all([
        db.abExpense.count({ where: { tenantId, isPersonal: false } }),
        db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
      ]);

      if (total === 0 || uncategorized / total <= 0.10) {
        results.push({ tenantId, action: 'skip' });
        continue;
      }

      // Run LLM auto-categorizer (force=true bypasses 20h dedupe)
      await autoCategorizeForTenant(tenantId, { force: true });

      // Re-check after run
      const [total2, uncategorized2] = await Promise.all([
        db.abExpense.count({ where: { tenantId, isPersonal: false } }),
        db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
      ]);

      if (total2 === 0 || uncategorized2 / total2 <= 0.10) {
        results.push({ tenantId, action: 'categorized' });
        continue;
      }

      // Still above threshold — send nudge (24h dedupe via AbEvent)
      const recentNudge = await db.abEvent.findFirst({
        where: {
          tenantId,
          eventType: 'auto_cat.watchdog_nudge',
          createdAt: { gte: new Date(Date.now() - NUDGE_COOLDOWN_MS) },
        },
      });

      if (!recentNudge) {
        const msg = `You have ${uncategorized2} uncategorized expenses — I couldn't auto-categorize them. Type 'categorize expenses' or visit the Expenses page to review.`;
        await sendToAllChannels(tenantId, msg);
        await db.abEvent.create({
          data: {
            tenantId,
            eventType: 'auto_cat.watchdog_nudge',
            actor: 'system',
            action: { uncategorized: uncategorized2, total: total2 },
          },
        });
        results.push({ tenantId, action: 'nudged' });
      } else {
        results.push({ tenantId, action: 'nudge_skipped_cooldown' });
      }
    } catch (err) {
      reportError(`[auto-cat-watchdog] tenant ${tenantId}`, err);
      results.push({ tenantId, action: 'error' });
    }
  }

  return NextResponse.json({ success: true, data: { processed: results.length, results } });
}
