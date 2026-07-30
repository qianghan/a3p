/**
 * Rate limiting backed by a SHARED store (Postgres), not process memory.
 *
 * The previous implementation used an in-process Map. On Vercel each serverless
 * instance has its own memory, so that limit was per-instance, reset on every
 * cold start, and bypassable by spreading requests across instances — i.e.
 * effectively unenforced in production. These are the auth endpoints (login,
 * register, password reset, email verification), so the limit must hold
 * globally.
 *
 * Uses the existing database rather than adding Redis/KV infrastructure: two
 * cheap indexed queries, on endpoints that already hit the DB.
 */
import { NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { errors, getClientIP } from '@/lib/api/response';

type RateLimitOptions = {
  keyPrefix: string;
  windowMs?: number;
  maxRequests?: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 10;

/**
 * Consume one request against `keyPrefix:<client ip>`. Returns a 429 response
 * when the caller is over the limit, or null to proceed.
 *
 * Fail-open by design: if the store is unreachable the request is allowed. The
 * alternative — locking everyone out of login because the limiter is down — is
 * worse, and these endpoints hit the same database anyway. Login additionally
 * has a DB-backed account lockout, which is the real brute-force defense.
 */
export async function enforceRateLimit(
  request: Request,
  options: RateLimitOptions,
): Promise<NextResponse | null> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const ip = getClientIP(request);
  if (!ip) return null;
  const key = `${options.keyPrefix}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);

  try {
    // Atomically increment an existing, unexpired window. `updateMany` with
    // `increment` is a single UPDATE, so concurrent requests can't lose counts.
    const bumped = await db.rateLimit.updateMany({
      where: { key, resetAt: { gt: now } },
      data: { count: { increment: 1 } },
    });

    if (bumped.count === 0) {
      // No row yet, or the window lapsed — (re)start it. This request is the
      // first of the new window, so it is always allowed.
      await db.rateLimit.upsert({
        where: { key },
        create: { key, count: 1, resetAt },
        update: { count: 1, resetAt },
      });
      return null;
    }

    const row = await db.rateLimit.findUnique({ where: { key } });
    if (!row || row.count <= maxRequests) return null;

    const retryAfter = Math.max(1, Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000));
    const response = errors.rateLimited(retryAfter);
    response.headers.set('Retry-After', retryAfter.toString());
    return response;
  } catch (err) {
    console.warn('[rate-limit] store unavailable — allowing request:', err);
    return null;
  }
}
