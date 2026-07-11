import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpSession } from './session-store';
import {
  destroySession,
  evictIdleSessions,
  resolveSessionForRequest,
  sessions,
  SESSION_IDLE_TTL_MS,
} from './session-store';

function makeSession(tenantId: string, lastUsedAt: number): McpSession {
  return {
    // Only `close()` is ever called on `transport` by this module; a full
    // `StreamableHTTPServerTransport` isn't needed to exercise the
    // tenant-check / TTL-eviction logic under test.
    transport: { close: vi.fn().mockResolvedValue(undefined) } as unknown as McpSession['transport'],
    server: {} as McpSession['server'],
    tenantId,
    lastUsedAt,
  };
}

afterEach(() => {
  sessions.clear();
  vi.restoreAllMocks();
});

describe('resolveSessionForRequest — tenant-binding revalidation', () => {
  it('reuses a session when the authenticated tenant matches the session-creating tenant', () => {
    const now = 1_000_000;
    const session = makeSession('tenant-a', now - 1000);
    sessions.set('sess-1', session);

    const result = resolveSessionForRequest('sess-1', 'tenant-a', now);

    expect(result).toEqual({ kind: 'reuse', session });
    expect(sessions.get('sess-1')).toBe(session);
    // lastUsedAt is refreshed on reuse.
    expect(session.lastUsedAt).toBe(now);
  });

  it('rejects and destroys the session when a live Mcp-Session-Id is presented alongside a different tenant', () => {
    const now = 1_000_000;
    const session = makeSession('tenant-a', now - 1000);
    sessions.set('sess-1', session);

    const result = resolveSessionForRequest('sess-1', 'tenant-b', now);

    expect(result).toEqual({ kind: 'tenant-mismatch' });
    // The session must not be left usable by anyone after a mismatch is
    // observed — not even by the original tenant-a caller on a later retry.
    expect(sessions.has('sess-1')).toBe(false);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });

  it('does not touch other tenants sessions when resolving a mismatch for one session id', () => {
    const now = 1_000_000;
    const sessionA = makeSession('tenant-a', now - 1000);
    const sessionC = makeSession('tenant-c', now - 1000);
    sessions.set('sess-1', sessionA);
    sessions.set('sess-2', sessionC);

    resolveSessionForRequest('sess-1', 'tenant-b', now);

    expect(sessions.has('sess-1')).toBe(false);
    expect(sessions.get('sess-2')).toBe(sessionC);
  });

  it('returns "unknown" for a session id this instance has no record of', () => {
    const result = resolveSessionForRequest('nonexistent', 'tenant-a', Date.now());
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('returns "none" when no session id is presented', () => {
    const result = resolveSessionForRequest(null, 'tenant-a', Date.now());
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('evictIdleSessions — idle-TTL eviction', () => {
  it('evicts a session whose lastUsedAt is older than the TTL', () => {
    const now = 1_000_000;
    const stale = makeSession('tenant-a', now - SESSION_IDLE_TTL_MS - 1);
    sessions.set('stale-session', stale);

    evictIdleSessions(now);

    expect(sessions.has('stale-session')).toBe(false);
    expect(stale.transport.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a session that is within the TTL window', () => {
    const now = 1_000_000;
    const fresh = makeSession('tenant-a', now - SESSION_IDLE_TTL_MS + 1);
    sessions.set('fresh-session', fresh);

    evictIdleSessions(now);

    expect(sessions.has('fresh-session')).toBe(true);
    expect(fresh.transport.close).not.toHaveBeenCalled();
  });

  it('evicts only the idle sessions, leaving active ones in place', () => {
    const now = 1_000_000;
    const stale = makeSession('tenant-a', now - SESSION_IDLE_TTL_MS - 1);
    const fresh = makeSession('tenant-b', now - 1000);
    sessions.set('stale-session', stale);
    sessions.set('fresh-session', fresh);

    evictIdleSessions(now);

    expect(sessions.has('stale-session')).toBe(false);
    expect(sessions.has('fresh-session')).toBe(true);
  });

  it('is exercised opportunistically by resolveSessionForRequest on every call', () => {
    const now = 1_000_000;
    const stale = makeSession('tenant-a', now - SESSION_IDLE_TTL_MS - 1);
    sessions.set('stale-session', stale);

    // A wholly unrelated request (different/absent session id) should still
    // trigger the sweep, since there is no separate timer driving this in
    // the current in-memory, single-instance design.
    resolveSessionForRequest(null, 'tenant-z', now);

    expect(sessions.has('stale-session')).toBe(false);
  });

  it('respects a custom ttlMs override', () => {
    const now = 1_000_000;
    const session = makeSession('tenant-a', now - 100);
    sessions.set('sess-1', session);

    evictIdleSessions(now, 50);

    expect(sessions.has('sess-1')).toBe(false);
  });
});

describe('destroySession', () => {
  it('removes the entry from the map and closes its transport', () => {
    const session = makeSession('tenant-a', Date.now());
    sessions.set('sess-1', session);

    destroySession('sess-1', session);

    expect(sessions.has('sess-1')).toBe(false);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });
});
