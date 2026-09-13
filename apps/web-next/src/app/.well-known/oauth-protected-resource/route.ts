import { NextResponse } from 'next/server';
import { mcpIssuer, mcpResourceUrl } from '@/lib/mcp/oauth-provider';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';

/**
 * The ROOT metadata path. Clients reach here only as a fallback — the URL they
 * ask for first is the path-inserted one served by ./[...resource]/route.ts
 * (RFC 9728 §3.1). Kept because the fallback is real and cheap to honour, and
 * both must describe the same resource: hence the shared helpers rather than
 * two hand-written copies.
 */
export async function GET() {
  // Kill switch: don't advertise a live protected resource for a deployment
  // where the whole MCP/OAuth surface is supposed to be off.
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: "AgentBook's Claude/MCP connector isn't turned on for this account yet" }, { status: 503 });
  }

  return NextResponse.json({
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuer()],
  });
}
