/**
 * Idempotency helper for the Telegram webhook (PR 21).
 *
 * Telegram retries webhook deliveries when the receiver times out or
 * 5xx's. Without dedup, a retry could double-book an expense or
 * re-create an invoice. This module owns the claim/cache contract:
 *
 *   - claimKey            — race-safe "first one wins" via the unique
 *                           PK on `AbIdempotencyKey`. Returns true on
 *                           the first call, false on collisions
 *                           (Prisma P2002).
 *   - recordResponse      — best-effort cache of the response body so
 *                           a later replay can return the same payload.
 *   - getCachedResponse   — fetch the cached body for a key, or null.
 *   - pruneIdempotencyKeys — daily housekeeping: drop rows past the
 *                           retention window (default 24h, well past
 *                           Telegram's retry budget).
 *
 * Tenant scope: writes carry the tenantId so we can reason about who
 * owns each row, but reads use the key alone — by construction a
 * `tg_update:<id>` is globally unique across tenants (Telegram update
 * ids are monotonic per bot).
 */

import 'server-only';
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma as db } from '@naap/database';

export interface IdemKey {
  key: string;
  tenantId?: string;
}

export interface IdemResult<T> {
  cached: boolean;
  response?: T;
}

/**
 * Claim an idempotency key. Returns true on the first claim, false if
 * the key was already taken (the caller should short-circuit and let
 * `getCachedResponse` deliver the previous reply).
 *
 * Race-safe: relies on the unique PK on `AbIdempotencyKey.key`. Two
 * concurrent retries both call `create`, exactly one succeeds, the
 * loser hits Prisma error code P2002 and is mapped to `false`.
 */
export async function claimKey(key: string, tenantId: string): Promise<boolean> {
  try {
    await db.abIdempotencyKey.create({
      data: { key, tenantId },
    });
    return true;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      // Lost the race — the key was already claimed by an earlier
      // delivery (or a concurrent retry). The caller should treat this
      // as a duplicate and respond with the cached body.
      return false;
    }
    // Real DB error — let the route handler decide (it currently
    // returns `{ ok: true }` to keep Telegram from retrying further).
    throw err;
  }
}

/**
 * Cache the response body so a replay can return the original payload
 * verbatim. Best-effort: a write failure here doesn't roll back the
 * already-completed work, so we swallow it and let the next replay
 * fall through to the generic idempotent marker.
 */
export async function recordResponse(
  key: string,
  response: unknown,
): Promise<void> {
  try {
    await db.abIdempotencyKey.update({
      where: { key },
      data: { response: response as never },
    });
  } catch (err) {
    console.warn('[idempotency] recordResponse failed:', err);
  }
}

/**
 * Look up the cached response for a previously-claimed key. Returns
 * `null` if the key was never claimed, or was claimed but never had
 * its response written (e.g. handler crashed mid-flight).
 */
export async function getCachedResponse(key: string): Promise<unknown | null> {
  const row = await db.abIdempotencyKey.findUnique({ where: { key } });
  if (!row || row.response == null) return null;
  return row.response as unknown;
}

export interface PruneOptions {
  /** Retain rows newer than this many hours. Defaults to 24. */
  olderThanHours?: number;
}

export interface PruneResult {
  deleted: number;
}

/**
 * Daily housekeeping — drop rows older than `olderThanHours` (default
 * 24). Telegram's retry window is much shorter than that, so anything
 * past 24 hours has no chance of being a meaningful replay.
 *
 * Also prunes expired `AbHttpIdempotencyKey` rows (G-020, PR 15) — the
 * HTTP table tracks its own `expiresAt` per row, so we delete any row
 * whose TTL has passed. Both deletes are independent; failure of one
 * doesn't roll back the other.
 */
export async function pruneIdempotencyKeys(
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const hours = opts.olderThanHours ?? 24;
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const [telegramRes, httpRes] = await Promise.all([
    db.abIdempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } },
    }),
    db.abHttpIdempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    }),
  ]);
  return { deleted: telegramRes.count + httpRes.count };
}

// ---------------------------------------------------------------------
// HTTP `Idempotency-Key` wrapper (G-020, PR 15).
//
// Distinct contract from the Telegram helpers above:
//   - Telegram: server-generated key (`tg_update:<id>`), claim-first.
//   - HTTP: client-supplied `Idempotency-Key` header, body-hash dedup.
//
// Routes opt in by wrapping their POST handler with `withHttpIdempotency`.
// If no header is sent, the handler runs as before (gradual adoption).
// ---------------------------------------------------------------------

/** TTL for cached HTTP idempotency rows. 24h matches the Telegram prune cron. */
const HTTP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface HttpIdempotencyHandlerResult {
  status: number;
  /** JSON-serializable response body. Union shapes are allowed — the wrapper just forwards. */
  body: unknown;
}

export interface HttpIdempotencyOptions {
  tenantId: string;
  /** Stable string identifying the route, e.g. `POST /api/v1/agentbook-expense/expenses`. */
  endpoint: string;
  /**
   * Runs the actual work. Receives the raw request body string (already
   * consumed by the wrapper to compute the hash). Must NOT call
   * `request.json()` or `request.text()` again — the stream is gone.
   */
  handler: (rawBody: string) => Promise<HttpIdempotencyHandlerResult>;
}

/**
 * Wrap a Next.js POST handler with HTTP `Idempotency-Key` semantics.
 *
 * Behavior:
 *   - No `Idempotency-Key` header → run handler, no caching. Pass-through
 *     for legacy callers.
 *   - First call with key → run handler, cache `(status, body)` keyed by
 *     `(tenantId, key, endpoint)` with a 24h TTL.
 *   - Replay with same key + same body → return cached response, handler
 *     NOT called.
 *   - Replay with same key + different body → 422 (caller misuse).
 *   - Replay with same key but cache expired → fall through to fresh
 *     execution + overwrite the row.
 *
 * Tenant scope: cache rows are keyed on `tenantId` so a key collision
 * across tenants can never leak data — each tenant has its own keyspace.
 */
export async function withHttpIdempotency(
  request: NextRequest,
  opts: HttpIdempotencyOptions,
): Promise<NextResponse> {
  const headerKey = request.headers.get('idempotency-key');
  // We always read the body — even when no header is sent — because the
  // handler must receive a `rawBody` string (the stream is single-shot).
  const rawBody = await request.text();

  // No idempotency key → no caching. Pass through.
  if (!headerKey) {
    const result = await opts.handler(rawBody);
    return NextResponse.json(result.body, { status: result.status });
  }

  const requestHash = createHash('sha256').update(rawBody).digest('hex');
  const now = new Date();

  const existing = await db.abHttpIdempotencyKey.findUnique({
    where: {
      tenantId_key_endpoint: {
        tenantId: opts.tenantId,
        key: headerKey,
        endpoint: opts.endpoint,
      },
    },
  });

  if (existing) {
    if (existing.expiresAt < now) {
      // Expired → fall through to fresh execution (and overwrite below).
    } else if (existing.requestHash !== requestHash) {
      // Same key, different body → caller misuse. Idempotency keys must
      // pin to a single request payload until they expire.
      return NextResponse.json(
        {
          success: false,
          error: 'Idempotency-Key already used with a different request body',
        },
        { status: 422 },
      );
    } else {
      // Cache hit — replay the prior response without re-running the
      // handler. Parse `responseJson` defensively; on parse failure,
      // return the raw string so we never lose the recorded reply.
      let body: unknown;
      try {
        body = JSON.parse(existing.responseJson);
      } catch {
        body = existing.responseJson;
      }
      return NextResponse.json(body, { status: existing.status });
    }
  }

  // Fresh execution.
  const result = await opts.handler(rawBody);

  // Best-effort cache write. If the upsert fails (e.g. concurrent write
  // lost the unique-PK race), the response was already produced — return
  // it. A subsequent replay will either hit the row that the other call
  // wrote, or — if the write was lost entirely — re-execute.
  try {
    await db.abHttpIdempotencyKey.upsert({
      where: {
        tenantId_key_endpoint: {
          tenantId: opts.tenantId,
          key: headerKey,
          endpoint: opts.endpoint,
        },
      },
      create: {
        tenantId: opts.tenantId,
        key: headerKey,
        endpoint: opts.endpoint,
        requestHash,
        responseJson: JSON.stringify(result.body),
        status: result.status,
        expiresAt: new Date(now.getTime() + HTTP_IDEMPOTENCY_TTL_MS),
      },
      update: {
        requestHash,
        responseJson: JSON.stringify(result.body),
        status: result.status,
        expiresAt: new Date(now.getTime() + HTTP_IDEMPOTENCY_TTL_MS),
        createdAt: now,
      },
    });
  } catch (err) {
    console.warn('[idempotency] HTTP cache upsert failed:', err);
  }

  return NextResponse.json(result.body, { status: result.status });
}
