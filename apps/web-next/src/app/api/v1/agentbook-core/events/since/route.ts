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

// PR 63: in-process cache to absorb the polling fan-out. Every active
// tab polls this every 10s; on a busy tenant with 5 open tabs that's
// 5 requests/10s = 30/min. Caching for 5s collapses that to ~12/min,
// and the ETag path drops it further.
//
// The cache is keyed by tenantId + a 5-second bucket of `since`. Bucket
// rounding ensures requests with slightly-different `since` (clock drift,
// poll skew) still hit the same cache entry within the same bucket window.
//
// LRU size 256: with one entry per (tenant × bucket) this holds ~256
// recent tenants' last poll. A Vercel function instance typically
// serves a few hundred tenants over its lifetime — well within budget.

interface CacheEntry {
  expiresAt: number;
  body: string;
  etag: string;
  latestAt: string | null;
}

const CACHE_TTL_MS = 5_000;
const CACHE_MAX_SIZE = 256;
const cache = new Map<string, CacheEntry>();

function bucketKey(tenantId: string, since: Date): string {
  const bucket = Math.floor(since.getTime() / CACHE_TTL_MS);
  return `${tenantId}:${bucket}`;
}

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function setCached(key: string, entry: CacheEntry): void {
  // Evict the oldest entry when full. Map iteration order is insertion
  // order so the first key is the oldest.
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

function makeEtag(latestAt: string | null, count: number): string {
  // Weak ETag — the count + latestAt fully describe the response.
  return `W/"${latestAt ?? 'empty'}-${count}"`;
}

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
    // PR 63: serve from in-process LRU when the same (tenant, since-bucket)
    // was queried within CACHE_TTL_MS. Different tabs polling at the same
    // cadence hit the same bucket; same tab polling repeatedly hits the
    // ETag short-circuit below.
    const cacheKey = bucketKey(tenantId, since);
    const ifNoneMatch = request.headers.get('if-none-match');
    const cached = getCached(cacheKey);

    if (cached) {
      // ETag match → 304 with no body. Browser keeps using its own cached
      // copy. Saves DB query AND JSON serialization on the hot path.
      if (ifNoneMatch && ifNoneMatch === cached.etag) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: cached.etag,
            'Cache-Control': 'private, max-age=2',
          },
        });
      }
      return new NextResponse(cached.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ETag: cached.etag,
          'Cache-Control': 'private, max-age=2',
          'X-Cache': 'HIT',
        },
      });
    }

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
    const body = JSON.stringify({
      latestAt,
      count: events.length,
      kinds,
    });
    const etag = makeEtag(latestAt, events.length);

    setCached(cacheKey, {
      body,
      etag,
      latestAt,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    // Honor If-None-Match even on first-miss so a client that has a
    // stale-but-matching ETag still gets a 304.
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=2',
        },
      });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: etag,
        // Short cache so simultaneous polls from multiple tabs don't all
        // hit the DB. Adds at most 2s of staleness.
        'Cache-Control': 'private, max-age=2',
        'X-Cache': 'MISS',
      },
    });
  } catch (err) {
    console.error('[events/since]', err);
    return NextResponse.json({ error: 'failed to query events' }, { status: 500 });
  }
}
