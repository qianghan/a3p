/**
 * Audit-log retention cron (PR 59).
 *
 * AbEvent is the high-write audit + telemetry table — every API call
 * that mutates state writes at least one row, and the PR 58
 * agent.step_started / agent.step_completed pair doubles the throughput
 * on multi-step plans. Without retention the table grows linearly with
 * usage; eventually scans degrade.
 *
 * Policy:
 *   - Default retention: 365 days.
 *   - Override per-deploy via AUDIT_EVENT_RETENTION_DAYS env var
 *     (clamped to [30, 3650] for safety — neither <30d nor >10y is
 *     a sane production retention window).
 *   - Hard-deletes in chunks of CHUNK_SIZE (default 5000) to avoid
 *     long-running DELETEs on tables with millions of rows.
 *
 * Schedule: 03:00 UTC weekly (Sunday). The off-hours weekly cadence
 * keeps the index-rebuild noise off the daily critical-path window.
 *
 * Bearer-gated by CRON_SECRET. Idempotent — same-day reruns delete
 * fewer rows.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const CHUNK_SIZE = 5000;
const MAX_CHUNKS_PER_RUN = 50; // cap a single cron to ~250k rows

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getRetentionDays(): number {
  const raw = process.env.AUDIT_EVENT_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.round(n)));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(request.headers.get('authorization'), process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const retentionDays = getRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  let totalDeleted = 0;
  let chunks = 0;
  const startedAt = Date.now();

  try {
    // Loop: keep deleting until we either run out of rows below the cutoff
    // OR hit MAX_CHUNKS_PER_RUN. The deleteMany returns count, so we
    // can detect "nothing more to delete" without a separate findFirst.
    while (chunks < MAX_CHUNKS_PER_RUN) {
      // Postgres + Prisma don't support LIMIT on deleteMany directly, so
      // we pre-select IDs and delete by id. Chunked SELECT + DELETE.
      const batch = await db.abEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: CHUNK_SIZE,
      });
      if (batch.length === 0) break;
      const ids = batch.map((b) => b.id);
      const result = await db.abEvent.deleteMany({
        where: { id: { in: ids } },
      });
      totalDeleted += result.count;
      chunks += 1;
      // Safety: if a chunk somehow returns 0 deletes (race condition with
      // an external truncate), bail rather than infinite-loop.
      if (result.count === 0) break;
    }

    const durationMs = Date.now() - startedAt;
    return NextResponse.json({
      success: true,
      data: {
        retentionDays,
        cutoff: cutoff.toISOString(),
        totalDeleted,
        chunks,
        chunkSize: CHUNK_SIZE,
        durationMs,
        truncated: chunks >= MAX_CHUNKS_PER_RUN,
      },
    });
  } catch (err) {
    void reportError('cron/audit-retention failed', err, {
      source: 'cron/audit-retention',
      retentionDays,
      totalDeleted,
      chunks,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
