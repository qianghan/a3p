import 'server-only';
import Provider from 'oidc-provider';
import { PrismaOidcAdapter } from '@naap/database';

let instance: Provider | undefined;

export function getOAuthProvider(): Provider {
  if (instance) return instance;

  const issuer = process.env.AGENTBOOK_MCP_ISSUER || 'https://agentbook.brainliber.com';

  instance = new Provider(issuer, {
    adapter: PrismaOidcAdapter,
    clients: [], // no static clients — Dynamic Client Registration only (Task 4)
    features: {
      registration: { enabled: true, initialAccessToken: false }, // open DCR, per MCP convention
      revocation: { enabled: true },
      devInteractions: { enabled: false }, // we render our own login/consent (Task 5)
    },
    pkce: { required: () => true }, // OAuth 2.1: PKCE mandatory for every client
    scopes: ['agentbook:full'],
    ttl: {
      AuthorizationCode: 60, // seconds
      AccessToken: 60 * 60, // 1 hour
      RefreshToken: 60 * 60 * 24 * 30, // 30 days
    },
    routes: {
      authorization: '/api/v1/oauth/authorize',
      token: '/api/v1/oauth/token',
      registration: '/api/v1/oauth/register',
      revocation: '/api/v1/oauth/revoke',
    },
  });

  return instance;
}
