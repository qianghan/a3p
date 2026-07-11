import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from './oauth-provider';

function unauthorized(message: string): { error: NextResponse } {
  const response = NextResponse.json(
    { error: { code: 'invalid_token', message } },
    { status: 401 },
  );
  response.headers.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${message}"`);
  return { error: response };
}

export async function authenticateMcpRequest(
  request: NextRequest,
): Promise<{ userId: string; tenantId: string; clientId: string } | { error: NextResponse }> {
  const authHeader = request.headers.get('authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return unauthorized('Missing bearer token');
  }

  const provider = getOAuthProvider();
  const found = await provider.AccessToken.find(token);
  if (!found) {
    return unauthorized('Token not found or expired');
  }

  // tenantId === accountId per the current 1:1 tenancy model
  // (apps/web-next/src/lib/agentbook-tenant.ts:13) — revisit if that changes.
  return { userId: found.accountId, tenantId: found.accountId, clientId: found.clientId };
}
