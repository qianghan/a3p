import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';
import { checkRateLimit, normalizeClientIp } from '@/lib/mcp/rate-limit';

// Rate-limits an unauthenticated, IP-keyed endpoint (token issuance, client
// registration) using the same documented trade-off in both cases: no
// x-forwarded-for means there's no signal to distinguish one header-less
// caller from another, so every header-less caller intentionally shares a
// single bucket with a more generous ceiling than the per-IP rate, rather
// than faking fairness with a mechanism that doesn't work (e.g. a fresh
// random key per request, which never blocks anything AND leaks memory
// forever).
async function rateLimitByIp(
  request: NextRequest,
  endpoint: 'token' | 'register',
  perIpLimit: number,
  unknownLimit: number,
): Promise<NextResponse | null> {
  const ip = normalizeClientIp(request.headers.get('x-forwarded-for'));
  const key = ip ? `oauth-${endpoint}:${ip}` : `oauth-${endpoint}:unknown`;
  const limit = ip ? perIpLimit : unknownLimit;
  const allowed = await checkRateLimit(key, limit, 60_000);
  return allowed ? null : NextResponse.json({ error: 'rate_limited' }, { status: 429 });
}

// Mounts oidc-provider's Node request handler behind this catch-all route.
// oidc-provider (Koa-based) owns routing internally for every path configured
// under `routes` in getOAuthProvider() — authorize, token, register, revoke —
// so this handler just adapts Next's Web Request/Response to genuine Node
// IncomingMessage/ServerResponse and hands off to `provider.callback()`.
async function handle(request: NextRequest): Promise<Response> {
  // Kill switch: with the flag off, the entire OAuth issuer (DCR, authorize,
  // token, revoke) must be unreachable, not just MCP tool execution — a
  // disabled deployment shouldn't still let a client register and mint
  // tokens against an agent surface that's supposed to be off.
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: 'MCP is not enabled for this deployment' }, { status: 503 });
  }

  const pathname = request.nextUrl.pathname;

  // Rate limit the token endpoint by client IP before delegating to
  // oidc-provider — token requests aren't behind `authenticateMcpRequest`
  // (that's what they're issuing), so there's no `userId` to key on yet,
  // and the token endpoint is the most attractive abuse target here (it's
  // what actually mints credentials).
  if (pathname.endsWith('/token')) {
    const limited = await rateLimitByIp(request, 'token', 20, 100);
    if (limited) return limited;
  }

  // `/register` (Dynamic Client Registration) is fully open by design
  // (`initialAccessToken: false` in oauth-provider.ts, per MCP convention) —
  // no auth, no existing rate limit, and every successful call persists a
  // non-expiring `Client` row. Rate limit it the same way as `/token` so an
  // unauthenticated caller can't mint unbounded client registrations.
  // Tighter than `/token`'s ceiling since a legitimate integration registers
  // a client once, rarely repeatedly.
  if (pathname.endsWith('/register')) {
    const limited = await rateLimitByIp(request, 'register', 5, 20);
    if (limited) return limited;
  }

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  provider.callback()(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
