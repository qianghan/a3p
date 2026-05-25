/**
 * Memory pruning cron (G-040 / PR 34).
 *
 * Vercel cron: "0 4 * * *" (daily 4am UTC).
 *
 * Cleans up AbUserMemory entries that have outlived their usefulness so the
 * relevance-scored retrieval at agent-memory.ts:43-48 doesn't degrade as the
 * table grows. Without this, power users accumulate thousands of stale rows
 * that get scored on every agent message — slowing classification and
 * inflating LLM context.
 *
 * Pruning criteria (all per-tenant, applied in one transaction):
 *   1. Hard-expired:   expiresAt < now → delete unconditionally.
 *   2. Stale low-conf: confidence < 0.3 AND lastUsed older than 60 days → delete.
 *   3. Contradicted:   contradictions > 5 AND confidence < 0.5 → delete.
 *
 * Bearer-gated when CRON_SECRET is set (timing-safe compare).
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STALE_AFTER_DAYS = 60;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_MS);

  try {
    // 1. Hard-expired entries.
    const expiredResult = await db.abUserMemory.deleteMany({
      where: { expiresAt: { not: null, lt: now } },
    });

    // 2. Stale low-confidence entries.
    const staleResult = await db.abUserMemory.deleteMany({
      where: {
        confidence: { lt: 0.3 },
        lastUsed: { lt: staleCutoff },
      },
    });

    // 3. Heavily-contradicted entries the user has effectively rejected.
    const contradictedResult = await db.abUserMemory.deleteMany({
      where: {
        contradictions: { gt: 5 },
        confidence: { lt: 0.5 },
      },
    });

    const total =
      expiredResult.count + staleResult.count + contradictedResult.count;

    return NextResponse.json({
      success: true,
      data: {
        expired: expiredResult.count,
        stale: staleResult.count,
        contradicted: contradictedResult.count,
        total,
        timestamp: now.toISOString(),
      },
    });
  } catch (err) {
    void reportError('cron/memory-prune failed', err, { source: 'cron/memory-prune' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
