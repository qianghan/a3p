import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { checkRateLimit } from '@/lib/mcp/rate-limit';

// Mounts oidc-provider's Node request handler behind this catch-all route.
// oidc-provider (Koa-based) owns routing internally for every path configured
// under `routes` in getOAuthProvider() — authorize, token, register, revoke —
// so this handler just adapts Next's Web Request/Response to genuine Node
// IncomingMessage/ServerResponse and hands off to `provider.callback()`.
async function handle(request: NextRequest): Promise<Response> {
  // Rate limit the token endpoint by client IP before delegating to
  // oidc-provider — token requests aren't behind `authenticateMcpRequest`
  // (that's what they're issuing), so there's no `userId` to key on yet,
  // and the token endpoint is the most attractive abuse target here (it's
  // what actually mints credentials).
  if (request.nextUrl.pathname.endsWith('/token')) {
    const ip = request.headers.get('x-forwarded-for');
    let allowed: boolean;
    if (ip) {
      allowed = await checkRateLimit(`oauth-token:${ip}`, 20, 60_000); // 20 token requests/min/IP
    } else {
      // No x-forwarded-for header (local/dev, or an unusual proxy path — on
      // Vercel prod this header is always set, so this branch is mainly a
      // dev/edge-case robustness gap, not a live prod concern). A single
      // literal 'unknown' key at the same 20/min threshold meant for one IP
      // would let every header-less caller silently share one caller's
      // budget — e.g. 21 distinct header-less dev clients making 1 request
      // each would look identical to one client making 21, and the 21st
      // caller gets wrongly 429'd on traffic it never sent. So: check a
      // fresh, random per-request key (never collides with any other
      // caller's usage, so nobody is ever blocked by someone else's
      // traffic) AND a shared aggregate bucket with a higher, deliberately
      // generous ceiling (so header-less traffic in aggregate still can't
      // be unbounded — it's just no longer capped at the tight per-IP rate).
      const perRequestAllowed = await checkRateLimit(`oauth-token:unknown:${randomUUID()}`, 20, 60_000);
      const aggregateAllowed = await checkRateLimit('oauth-token:unknown-aggregate', 100, 60_000);
      allowed = perRequestAllowed && aggregateAllowed;
    }
    if (!allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  }

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  provider.callback()(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
