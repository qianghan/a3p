/**
 * GET /api/v1/agentbook-core/events/since — lightweight polling endpoint
 * for UI components that want to know when agent-driven state changes
 * happened on a tenant (G-033 / PR 28).
 *
 * Closes the "dashboard fetches independently, chat-driven changes don't
 * appear without refresh" finding from A.4. Pages mount the
 * `useAgentEvents` hook, poll this endpoint every 10 seconds (default),
 * and invalidate their data when the latest event timestamp moves
 * forward.
 *
 * Why not SSE: simpler, no streaming infra, works through proxies + Vercel
 * fluid compute without keep-alive headaches. 10s latency is fine for the
 * UI use case (logging an expense via chat → seeing it in the list).
 *
 * Response shape:
 *   {
 *     latestAt: "2026-05-22T12:34:56.789Z" | null,
 *     count: number,
 *     kinds: { [eventType]: count }
 *   }
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Hard cap so a stuck client can't pull half a year of events on every poll.
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ROWS = 200;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const params = request.nextUrl.searchParams;
  const sinceParam = params.get('ts');
  let since: Date;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'invalid ts (expected ISO-8601)' }, { status: 400 });
    }
    // Clamp lookback to MAX_LOOKBACK_MS so a never-polled-before client
    // doesn't blow up the query.
    const earliest = new Date(Date.now() - MAX_LOOKBACK_MS);
    since = parsed < earliest ? earliest : parsed;
  } else {
    since = new Date(Date.now() - MAX_LOOKBACK_MS);
  }

  try {
    const events = await db.abEvent.findMany({
      where: { tenantId, createdAt: { gt: since } },
      select: { eventType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    });

    const kinds: Record<string, number> = {};
    for (const e of events) {
      kinds[e.eventType] = (kinds[e.eventType] ?? 0) + 1;
    }

    const latestAt = events.length > 0 ? events[0].createdAt.toISOString() : null;

    return NextResponse.json(
      {
        latestAt,
        count: events.length,
        kinds,
      },
      {
        // Short cache so simultaneous polls from multiple tabs don't all
        // hit the DB. Adds at most 2s of staleness.
        headers: { 'Cache-Control': 'private, max-age=2' },
      },
    );
  } catch (err) {
    console.error('[events/since]', err);
    return NextResponse.json({ error: 'failed to query events' }, { status: 500 });
  }
}
