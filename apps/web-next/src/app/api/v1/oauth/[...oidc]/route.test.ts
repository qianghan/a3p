import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

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
  it('does not throttle header-less traffic at the tight per-IP threshold (regression: shared "unknown" bucket bug)', async () => {
    // Before the fix: every caller without an x-forwarded-for header was
    // keyed by the literal string 'unknown' at the SAME 20-req/min limit
    // meant for a single real IP. That meant N distinct header-less callers
    // making 1 request each would look identical to one caller making N, and
    // the 21st request — regardless of which caller sent it — got wrongly
    // 429'd on traffic it never generated itself.
    //
    // The fix gives every header-less request its own random per-request
    // key (so no caller's usage is ever miscounted against another's) plus a
    // separate, more generous shared aggregate cap (so header-less traffic
    // still can't be truly unbounded). Firing more requests than the old
    // 20/min threshold — and confirming none of them 429 — demonstrates that
    // header-less callers are no longer forced through that tight shared
    // bucket.
    for (let i = 0; i < 30; i++) {
      const res = await POST(makeTokenRequest());
      expect(res.status).not.toBe(429);
    }
  });

  it('still enforces a bound on aggregate header-less traffic (not unlimited)', async () => {
    // The random per-request key alone would never block anything (a fresh
    // key never collides), so the cap has to come from the shared aggregate
    // bucket. Exceed it and confirm a 429 eventually shows up.
    let sawRateLimited = false;
    for (let i = 0; i < 150; i++) {
      const res = await POST(makeTokenRequest());
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
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
