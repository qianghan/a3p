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

const { POST } = await import('./route');

function makeTokenRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/oauth/token', {
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
});
