import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Module-level session store, keyed by the MCP `Mcp-Session-Id` header value.
 *
 * This is deliberately in-memory and per-instance. It survives across HTTP
 * requests only as long as Vercel/Fluid Compute happens to route a session's
 * follow-up requests to the same warm function instance — there is no
 * cross-instance replication. That is an accepted, fail-safe trade-off (see
 * docs/superpowers/plans/2026-07-10-agentbook-mcp-server.md Task 8/8-fix
 * notes): if the instance holding a session recycles mid-elicitation, the
 * pending `elicitation/create` request simply times out (safe) rather than
 * silently producing a wrong answer. It is not correctness-critical data —
 * losing it just means the client has to re-`initialize`.
 *
 * Extracted out of `route.ts` (a Next.js App Router route file, which can
 * only export recognized HTTP-method handlers and a small set of route
 * config values) so the tenant-binding check and idle-TTL eviction logic can
 * be unit tested directly.
 */
export interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /**
   * The tenant this session was created for (i.e. the authenticated tenant
   * at `initialize` time). Every subsequent request that reuses this session
   * must re-prove it belongs to the same tenant — see
   * `resolveSessionForRequest` — otherwise a live session for tenant A could
   * be ridden by a request authenticated as tenant B, reading/writing tenant
   * A's financial data under tenant B's request.
   */
  tenantId: string;
  /** `Date.now()` timestamp of the last request that touched this session. */
  lastUsedAt: number;
}

/**
 * How long a session may sit idle (no requests touching it) before it's
 * evicted. Chosen for an interactive, human-confirmation use case (e.g. an
 * `ask_agentbook` elicitation round-trip): long enough that a real
 * in-progress confirmation isn't cut off, short enough to bound memory
 * growth from clients that vanish without sending `DELETE` (crash,
 * force-quit, network drop).
 */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const sessions = new Map<string, McpSession>();

/**
 * Tears down a session and removes it from the map. Reuses the same
 * transport-level cleanup the SDK performs for a client-initiated `DELETE`
 * (`transport.close()` — see
 * `StreamableHTTPServerTransport.handleDeleteRequest`/`close()`), so
 * TTL-based and tenant-mismatch-triggered eviction don't duplicate that
 * logic or leave SSE streams / pending requests dangling.
 */
export function destroySession(sessionId: string, session: McpSession): void {
  sessions.delete(sessionId);
  session.transport.close().catch((err) => {
    console.error('MCP session cleanup failed', err);
  });
}

/** Evicts every session whose `lastUsedAt` is older than `ttlMs`. */
export function evictIdleSessions(now: number, ttlMs: number = SESSION_IDLE_TTL_MS): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastUsedAt > ttlMs) {
      destroySession(sessionId, session);
    }
  }
}

export type SessionLookupResult =
  | { kind: 'reuse'; session: McpSession }
  | { kind: 'tenant-mismatch' }
  | { kind: 'unknown' }
  | { kind: 'none' };

/**
 * Resolves how a request should be handled given its (optional)
 * `Mcp-Session-Id` and the tenant it authenticated as. Also opportunistically
 * sweeps idle sessions on every call, so no separate timer/interval is
 * needed for the common in-request-path case.
 *
 * - No session ID -> `'none'` (caller should treat this as a fresh
 *   `initialize` request).
 * - Session ID present but not found -> `'unknown'` (caller returns 404).
 * - Session ID present, found, but bound to a *different* tenant than the
 *   one this request authenticated as -> `'tenant-mismatch'`. The session is
 *   destroyed as part of returning this result: once a mismatch is observed
 *   the session is never left usable again, since that's a signal something
 *   is wrong (bug or a real leaked-session-id attempt), not just "wrong
 *   request, try again".
 * - Session ID present, found, tenant matches -> `'reuse'`, with
 *   `lastUsedAt` refreshed to `now`.
 */
export function resolveSessionForRequest(
  sessionId: string | null,
  tenantId: string,
  now: number,
): SessionLookupResult {
  evictIdleSessions(now);

  if (!sessionId) return { kind: 'none' };

  const session = sessions.get(sessionId);
  if (!session) return { kind: 'unknown' };

  if (session.tenantId !== tenantId) {
    destroySession(sessionId, session);
    return { kind: 'tenant-mismatch' };
  }

  session.lastUsedAt = now;
  return { kind: 'reuse', session };
}
