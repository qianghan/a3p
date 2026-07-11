import 'server-only';
import Provider from 'oidc-provider';
import { PrismaOidcAdapter } from '@naap/database';

let instance: Provider | undefined;
let warnedNoJwks = false;

export interface JwkSet {
  keys: Record<string, unknown>[];
}

/**
 * Resolves the persistent JWKS oidc-provider should sign with from
 * `AGENTBOOK_MCP_JWKS` (a JSON-stringified JWK Set: `{ "keys": [...] }`).
 *
 * - Unset: returns `undefined` so callers fall back to oidc-provider's
 *   built-in ephemeral dev keystore — fine for a single local dev process,
 *   but NOT fine across multiple serverless instances in production, so we
 *   log a one-time warning.
 * - Set but invalid (bad JSON, or missing a `keys` array): throws. Silently
 *   falling back to ephemeral keys here would hide exactly the bug this
 *   env var exists to prevent, in what's presumably a production environment
 *   since the var was deliberately set.
 */
export function resolveJwks(): JwkSet | undefined {
  const raw = process.env.AGENTBOOK_MCP_JWKS;

  if (!raw) {
    if (!warnedNoJwks) {
      warnedNoJwks = true;
      console.warn(
        '[mcp/oauth-provider] AGENTBOOK_MCP_JWKS is not set — using oidc-provider\'s ephemeral, ' +
          'process-local signing keys. This is fine for local dev, but production deployments ' +
          'MUST set AGENTBOOK_MCP_JWKS (a JSON-stringified JWK Set, e.g. { "keys": [...] }), ' +
          'otherwise tokens signed by one serverless instance can fail to validate on another.'
      );
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENTBOOK_MCP_JWKS is set but is not valid JSON: ${(err as Error).message}`
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { keys?: unknown }).keys)
  ) {
    throw new Error(
      'AGENTBOOK_MCP_JWKS is set but does not look like a JWK Set — expected a JSON object ' +
        'of the shape { "keys": [...] }.'
    );
  }

  return parsed as JwkSet;
}

export function getOAuthProvider(): Provider {
  if (instance) return instance;

  const issuer = process.env.AGENTBOOK_MCP_ISSUER || 'https://agentbook.brainliber.com';
  const jwks = resolveJwks();

  instance = new Provider(issuer, {
    adapter: PrismaOidcAdapter,
    clients: [], // no static clients — Dynamic Client Registration only (Task 4)
    ...(jwks ? { jwks } : {}), // persistent signing keys (AGENTBOOK_MCP_JWKS); see resolveJwks()
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
