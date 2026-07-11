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
    // No x-forwarded-for header means this is realistically only local/dev
    // traffic or an unusual proxy path — on Vercel prod this header is
    // always set. There is no other signal available to distinguish one
    // header-less caller from another, so real fairness between anonymous
    // callers isn't achievable here. Rather than fake it with a mechanism
    // that doesn't actually work (e.g. a fresh random key per request, which
    // never blocks anything AND leaks memory forever), every header-less
    // caller intentionally shares a single bucket with a more generous
    // ceiling than the per-IP rate. This is an accepted, honestly-documented
    // trade-off for a dev-only/edge-case path, not a fairness guarantee.
    const key = ip ? `oauth-token:${ip}` : 'oauth-token:unknown';
    const limit = ip ? 20 : 100;
    const allowed = await checkRateLimit(key, limit, 60_000);
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
