import { NextRequest } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';

// Mounts oidc-provider's Node request handler behind this catch-all route.
// oidc-provider (Koa-based) owns routing internally for every path configured
// under `routes` in getOAuthProvider() — authorize, token, register, revoke —
// so this handler just adapts Next's Web Request/Response to genuine Node
// IncomingMessage/ServerResponse and hands off to `provider.callback()`.
async function handle(request: NextRequest): Promise<Response> {
  const provider = getOAuthProvider();
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  provider.callback()(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
