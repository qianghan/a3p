import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { validateSession } from '@/lib/api/auth';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';
import { prisma } from '@naap/database';

// Fetches the interaction oidc-provider is waiting on (client id, whether the
// user already granted consent) so the consent page can render. Needs a real
// `NextRequest` — `provider.interactionDetails(req, res)` reads the
// interaction id off the signed `_interaction` cookie on the actual incoming
// request, so it's called from a route handler (via Task 4a's adapter)
// rather than directly from the `oauth-consent` Server Component.
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Kill switch: this route is only ever reached as part of establishing a
  // brand-new connection (rendering the consent form) — with the flag off
  // there's no working consent flow to feed.
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: "AgentBook's Claude/MCP connector isn't turned on for this account yet" }, { status: 503 });
  }

  const token = request.cookies.get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes } = await nodeRequestResponseFromWeb(request);
  const details = await provider.interactionDetails(nodeReq, nodeRes);
  const clientId = details.params.client_id as string;

  const existingGrant = await prisma.mcpConsentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
  });

  // The consent screen is the single moment a person decides whether to
  // trust a new connection — showing them a raw DCR client_id here (e.g.
  // "yFjtmfwchm3UpDgsLFE7iI8uUIy6-_T7LxDAWIPI3Ej wants access") looks like a
  // phishing prompt, not an approval screen. Resolve the same client_name
  // connected-apps/route.ts already surfaces post-connection, so the name
  // shown here and in Settings -> Connected Apps is consistent.
  const clientRow = await prisma.oidcModel.findFirst({ where: { type: 'Client', id: clientId } });
  const clientName = (clientRow?.payload as { client_name?: string } | undefined)?.client_name || clientId;

  return NextResponse.json({
    clientId,
    clientName,
    alreadyGranted: Boolean(existingGrant && !existingGrant.revokedAt),
  });
}
