/**
 * Voice-transcript cache housekeeping cron (PR 19).
 *
 * Drops `AbVoiceTranscript` rows older than 30 days. The cache is for
 * dedup of replays and retries — tenants don't expect to "look up"
 * transcripts after the conversation moves on, so 30 days is a
 * generous retention window. The `file_id` from Telegram itself is
 * unstable longer-term (Telegram garbage-collects file paths after a
 * while), so caching beyond a month buys us nothing.
 *
 * Vercel cron suggested: "30 4 * * *" (04:30 UTC, off-peak).
 * Idempotent — same-day reruns just delete fewer rows.
 * Bearer-gated when `CRON_SECRET` is set.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { pruneVoiceTranscripts } from '@/lib/agentbook-voice-cache';
import { reportError } from '@/lib/logger';
import { requireCronSecret } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;


export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await pruneVoiceTranscripts({ olderThanDays: 30 });
    return NextResponse.json({
      success: true,
      data: { deleted: result.deleted, retentionDays: 30 },
    });
  } catch (err) {
    void reportError('cron/voice-cache-prune failed', err, { source: 'cron/voice-cache-prune' });
    return NextResponse.json(
      { success: false, error: 'prune failed' },
      { status: 500 },
    );
  }
}
