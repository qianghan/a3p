/**
 * In-memory sliding-window rate limiter for abuse-dampening on the MCP and
 * OAuth token endpoints.
 *
 * Deliberately per-instance, in-memory: acceptable for v1 abuse-dampening,
 * not a hard security boundary (a multi-instance deployment gets one bucket
 * per warm instance rather than one shared bucket). Revisit with a shared
 * store (e.g. Upstash Redis, already used elsewhere in the Vercel ecosystem)
 * if usage grows past a single deployment's worth of protection.
 */
const hits = new Map<string, number[]>();

// A key with no activity in this long is dead weight and gets swept away —
// deliberately much longer than any individual caller's `windowMs` (all
// current callers use 60s windows), so this only ever removes buckets that
// are genuinely stale for *every* plausible windowMs in use, never one a
// caller is still actively rate-limiting against.
const STALE_KEY_TTL_MS = 10 * 60_000; // 10 minutes

// Sweeping the whole map is O(distinct keys), so it's throttled to run at
// most this often rather than on every single call. Triggered opportunistically
// from inside checkRateLimit (no background timer) so this stays friendly to
// serverless/edge runtimes that don't keep a process alive between requests.
const SWEEP_INTERVAL_MS = 60_000; // 1 minute
let lastSweepAt = 0;

/**
 * Removes bucket keys that have had zero activity within `STALE_KEY_TTL_MS`.
 * Without this, a caller who cycles through many distinct rate-limit keys
 * (e.g. spoofed/rotating `x-forwarded-for` values hitting an unauthenticated
 * endpoint) would leave one abandoned Map entry behind per distinct value
 * forever — pruning timestamps *within* a key (below) only bounds an
 * individual bucket's array size, not the number of buckets themselves.
 */
function sweepStaleKeys(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, timestamps] of hits) {
    const fresh = timestamps.filter((t) => now - t < STALE_KEY_TTL_MS);
    if (fresh.length === 0) {
      hits.delete(key);
    } else if (fresh.length !== timestamps.length) {
      hits.set(key, fresh);
    }
  }
}

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  sweepStaleKeys(now);

  const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) {
    hits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

/**
 * Extracts the client-facing IP from a raw `x-forwarded-for` header value for
 * use as a rate-limit bucket key. `x-forwarded-for` is a comma-separated list
 * appended to by every proxy hop (`client, proxy1, proxy2, ...`); by
 * convention the *first* entry is the original client, so that's the only
 * part that should ever be used as a rate-limit key — using the raw header
 * verbatim would let a caller fragment its own requests across many distinct
 * "keys" just by varying what it sends after the first comma. Returns `null`
 * for a missing/empty header so callers can fall back to their own
 * documented shared-bucket behavior.
 */
export function normalizeClientIp(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.trim();
  return first || null;
}

/**
 * Test-only escape hatch: the number of distinct keys currently tracked in
 * the in-memory `hits` map. Used to assert callers don't mint unbounded
 * per-call unique keys (which would leak memory forever on a pre-auth
 * endpoint) — not for use outside tests.
 */
export function __getRateLimitKeyCountForTest(): number {
  return hits.size;
}

/**
 * Test-only escape hatch: whether a given key is still tracked in the
 * in-memory `hits` map. Used to assert stale-key eviction actually removes
 * abandoned buckets rather than just pruning timestamps within a key that's
 * still being accessed — not for use outside tests.
 */
export function __hasRateLimitKeyForTest(key: string): boolean {
  return hits.has(key);
}

/**
 * Test-only escape hatch: forces the next `checkRateLimit` call to run a
 * stale-key sweep regardless of `SWEEP_INTERVAL_MS` throttling — not for use
 * outside tests.
 */
export function __forceNextSweepForTest(): void {
  lastSweepAt = 0;
}
