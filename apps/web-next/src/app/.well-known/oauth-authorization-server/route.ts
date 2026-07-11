import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';

export async function GET() {
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
