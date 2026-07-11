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

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
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
 * Test-only escape hatch: the number of distinct keys currently tracked in
 * the in-memory `hits` map. Used to assert callers don't mint unbounded
 * per-call unique keys (which would leak memory forever on a pre-auth
 * endpoint) — not for use outside tests.
 */
export function __getRateLimitKeyCountForTest(): number {
  return hits.size;
}
