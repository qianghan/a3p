import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';

export async function GET() {
  // Kill switch: don't advertise a live protected resource for a deployment
  // where the whole MCP/OAuth surface is supposed to be off.
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: "AgentBook's Claude/MCP connector isn't turned on for this account yet" }, { status: 503 });
  }

  const provider = getOAuthProvider();
  return NextResponse.json({
    resource: `${provider.issuer}/api/v1/mcp`,
    authorization_servers: [provider.issuer],
  });
}
