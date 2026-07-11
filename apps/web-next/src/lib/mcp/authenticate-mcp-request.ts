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

function serviceUnavailable(message: string): { error: NextResponse } {
  const response = NextResponse.json(
    { error: { code: 'temporarily_unavailable', message } },
    { status: 503 },
  );
  response.headers.set(
    'WWW-Authenticate',
    `Bearer error="temporarily_unavailable", error_description="${message}"`,
  );
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
  let found;
  try {
    found = await provider.AccessToken.find(token);
  } catch (err) {
    // provider.AccessToken.find() only swallows verify()-time errors
    // (expired/malformed tokens) internally; the preceding adapter.find()
    // DB lookup (PrismaOidcAdapter -> prisma.oidcModel.findFirst) is not
    // guarded by oidc-provider itself, so a genuine infra failure (DB
    // connection drop, timeout, etc.) propagates as a rejection here.
    console.error('authenticateMcpRequest: AccessToken.find() failed', err);
    return serviceUnavailable('Token validation is temporarily unavailable');
  }
  if (!found) {
    return unauthorized('Token not found or expired');
  }

  // tenantId === accountId per the current 1:1 tenancy model
  // (apps/web-next/src/lib/agentbook-tenant.ts:13) — revisit if that changes.
  return { userId: found.accountId, tenantId: found.accountId, clientId: found.clientId };
}
