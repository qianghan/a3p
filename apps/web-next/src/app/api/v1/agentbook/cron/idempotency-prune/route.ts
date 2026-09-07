/**
 * Idempotency-key housekeeping cron (PR 21).
 *
 * Drops `AbIdempotencyKey` rows older than 24 hours. Telegram's retry
 * window is far shorter — anything past a day has zero chance of being
 * a meaningful replay, so the row is just dead weight.
 *
 * Vercel cron suggested: "15 4 * * *" (04:15 UTC, off-peak).
 * Idempotent — same-day reruns just delete fewer rows.
 * Bearer-gated when `CRON_SECRET` is set.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { pruneIdempotencyKeys } from '@/lib/agentbook-idempotency';
import { reportError } from '@/lib/logger';
import { requireCronSecret } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;


export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await pruneIdempotencyKeys({ olderThanHours: 24 });
    return NextResponse.json({
      success: true,
      data: { deleted: result.deleted, retentionHours: 24 },
    });
  } catch (err) {
    void reportError('cron/idempotency-prune failed', err, { source: 'cron/idempotency-prune' });
    return NextResponse.json(
      { success: false, error: 'prune failed' },
      { status: 500 },
    );
  }
}
