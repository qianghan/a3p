import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';

export async function GET() {
  // Kill switch: don't advertise a live OAuth issuer for a deployment where
  // the whole MCP/OAuth surface is supposed to be off.
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: 'MCP is not enabled for this deployment' }, { status: 503 });
  }

  const provider = getOAuthProvider();
  return NextResponse.json(provider.issuer && {
    issuer: provider.issuer,
    authorization_endpoint: `${provider.issuer}/api/v1/oauth/authorize`,
    token_endpoint: `${provider.issuer}/api/v1/oauth/token`,
    registration_endpoint: `${provider.issuer}/api/v1/oauth/register`,
    revocation_endpoint: `${provider.issuer}/api/v1/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['agentbook:full'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}
