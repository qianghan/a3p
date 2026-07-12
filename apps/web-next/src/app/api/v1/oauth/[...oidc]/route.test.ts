import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { __getRateLimitKeyCountForTest } from '@/lib/mcp/rate-limit';

// The route delegates all actual OIDC handling to oidc-provider via a Node
// req/res bridge; neither is relevant to the rate-limit fallback behavior
// under test here, so both are stubbed out to resolve immediately.
const mockCallback = vi.fn(() => vi.fn());
vi.mock('@/lib/mcp/oauth-provider', () => ({
  getOAuthProvider: () => ({ callback: mockCallback }),
}));

vi.mock('@/lib/mcp/node-web-adapter', () => ({
  nodeRequestResponseFromWeb: async () => ({
    nodeReq: {},
    nodeRes: {},
    responsePromise: Promise.resolve(new Response('ok', { status: 200 })),
  }),
}));

// This whole test file is exercising rate-limit/flag behavior, not oidc-provider
// itself, so the flag defaults to "on" here; the flag-off behavior gets its
// own describe block below with an explicit mock override.
const mockIsMcpEnabled = vi.fn(async () => true);
vi.mock('@/lib/mcp/mcp-flag', () => ({
  isMcpEnabled: () => mockIsMcpEnabled(),
}));

const { POST } = await import('./route');

function makeTokenRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/oauth/token', {
    method: 'POST',
    headers,
  });
}

function makeRegisterRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/oauth/register', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/v1/oauth/[...oidc] — /token rate-limit fallback with no x-forwarded-for', () => {
  it('shares a single bucket across all header-less callers, bounded at the aggregate ceiling (not unlimited, not "fair")', async () => {
    // There is no signal to distinguish one header-less caller from another,
    // so this deliberately does NOT provide fairness between anonymous
    // callers — it only guarantees the aggregate is bounded rather than
    // unbounded. 100 requests (the documented ceiling) should all succeed;
    // the 101st, from the same header-less bucket, should be rejected.
    for (let i = 0; i < 100; i++) {
      const res = await POST(makeTokenRequest());
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeTokenRequest());
    expect(res.status).toBe(429);
  });

  it('does not grow the rate-limit map per call (regression: unbounded memory growth from unique per-request keys)', async () => {
    const before = __getRateLimitKeyCountForTest();
    for (let i = 0; i < 50; i++) {
      await POST(makeTokenRequest());
    }
    const after = __getRateLimitKeyCountForTest();
    // All 50 header-less calls must collapse onto the same shared key, so
    // the map's key count grows by at most 1 (the single 'oauth-token:unknown'
    // bucket), never by anywhere near the number of calls made.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('keeps the existing per-IP behavior unchanged when x-forwarded-for IS present', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(makeTokenRequest({ 'x-forwarded-for': '203.0.113.9' }));
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeTokenRequest({ 'x-forwarded-for': '203.0.113.9' }));
    expect(res.status).toBe(429);
  });

  it('normalizes a multi-hop x-forwarded-for to its first (client-facing) entry', async () => {
    // '203.0.113.50' here is the same logical client as the previous test's
    // direct-IP case would be, just arriving through two extra proxy hops —
    // it must land in the same per-IP bucket, not a distinct one keyed off
    // the raw (unnormalized) header string.
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        makeTokenRequest({ 'x-forwarded-for': ' 203.0.113.50 , 10.0.0.1, 10.0.0.2' }),
      );
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeTokenRequest({ 'x-forwarded-for': '203.0.113.50, 10.0.0.9' }));
    expect(res.status).toBe(429);
  });
});

describe('POST /api/v1/oauth/[...oidc] — /register rate limiting (Finding 2: DCR was fully unrate-limited)', () => {
  it('rate limits a single registering IP well below the /token per-IP ceiling', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRegisterRequest({ 'x-forwarded-for': '198.51.100.1' }));
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeRegisterRequest({ 'x-forwarded-for': '198.51.100.1' }));
    expect(res.status).toBe(429);
  });

  it('shares a single bounded bucket across header-less callers, same fallback pattern as /token', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(makeRegisterRequest());
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeRegisterRequest());
    expect(res.status).toBe(429);
  });

  it('tracks /register and /token buckets independently for the same IP', async () => {
    const ip = '198.51.100.77';
    // Exhaust this IP's /register bucket (limit 5) ...
    for (let i = 0; i < 5; i++) {
      await POST(makeRegisterRequest({ 'x-forwarded-for': ip }));
    }
    const registerBlocked = await POST(makeRegisterRequest({ 'x-forwarded-for': ip }));
    expect(registerBlocked.status).toBe(429);

    // ... but /token for that same IP is a separate bucket and still fresh.
    const tokenRes = await POST(makeTokenRequest({ 'x-forwarded-for': ip }));
    expect(tokenRes.status).not.toBe(429);
  });
});

describe('POST /api/v1/oauth/[...oidc] — MCP feature flag kill switch (Finding 1)', () => {
  it('returns a clean 503 for every OIDC action (token, register, authorize, revoke) when the flag is off', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await POST(makeTokenRequest({ 'x-forwarded-for': '203.0.113.200' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/isn't turned on/i);
    // The provider callback (and therefore oidc-provider's own routing) must
    // never be invoked when the flag is off.
    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('checks the flag before rate limiting, so a disabled deployment does not even burn rate-limit budget', async () => {
    const before = __getRateLimitKeyCountForTest();
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    await POST(makeRegisterRequest({ 'x-forwarded-for': '203.0.113.201' }));
    const after = __getRateLimitKeyCountForTest();
    expect(after).toBe(before);
  });
});
