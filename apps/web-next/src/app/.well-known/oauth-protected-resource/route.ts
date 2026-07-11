import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';

export async function GET() {
  const provider = getOAuthProvider();
  return NextResponse.json({
    resource: `${provider.issuer}/api/v1/mcp`,
    authorization_servers: [provider.issuer],
  });
}
