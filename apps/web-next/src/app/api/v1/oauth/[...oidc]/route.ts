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
    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    const allowed = await checkRateLimit(`oauth-token:${ip}`, 20, 60_000); // 20 token requests/min/IP
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
