import { NextResponse } from 'next/server';
import {
  MCP_RESOURCE_PATH,
  mcpIssuer,
  mcpResourceUrl,
} from '@/lib/mcp/oauth-provider';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';

/**
 * Protected Resource Metadata at the PATH-INSERTED url, which is the one
 * clients actually request.
 *
 * RFC 9728 §3.1 forms the metadata URL for a resource by inserting
 * `/.well-known/oauth-protected-resource` between host and path. Our resource
 * is `https://host/api/v1/mcp`, so every MCP client asks for
 * `https://host/.well-known/oauth-protected-resource/api/v1/mcp` — not the
 * bare well-known path the sibling route serves.
 *
 * WHY THIS FILE EXISTS RATHER THAN A REDIRECT OR NOTHING AT ALL
 *
 * Nothing served this path, so it fell through to the client-side catch-all
 * at app/(dashboard)/[...slug]/page.tsx, which rendered for ANY unmatched
 * path and returned `200 text/html`. The MCP SDK falls back to the root
 * metadata URL only when the path-aware request 4xxs
 * (`shouldAttemptFallback`: `status >= 400 && status < 500`), so a 200 is
 * worse than a 404 here — it ends discovery with "found it", then throws
 * parsing an HTML page as JSON. The visible symptom was a client that could
 * not register and asked for a hand-entered OAuth client id instead.
 *
 * That catch-all has since been deleted, so an unmatched path now 404s on its
 * own. This route still earns its place: it is what serves the metadata for
 * the resource that DOES exist, and the 404 below is a deliberate, specific
 * answer rather than a fallthrough.
 *
 * Anything that is not our resource must therefore answer 404, deliberately,
 * so a client can fall back instead of being handed a page.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ resource: string[] }> },
): Promise<NextResponse> {
  const { resource } = await params;
  const requested = `/${(resource ?? []).join('/')}`;

  if (requested !== MCP_RESOURCE_PATH) {
    return NextResponse.json(
      { error: 'not_found', error_description: `No protected resource is published at ${requested}` },
      { status: 404 },
    );
  }

  // Kill switch: don't advertise a live protected resource for a deployment
  // where the whole MCP/OAuth surface is off. Checked AFTER the path match so
  // an unrelated path gets its 404 either way.
  if (!(await isMcpEnabled())) {
    return NextResponse.json(
      { error: "AgentBook's Claude/MCP connector isn't turned on for this account yet" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuer()],
  });
}
