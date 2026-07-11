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
    interactions: {
      // Every interaction (login + consent) is rendered by our own page —
      // devInteractions is disabled above, so this is the only login/consent
      // UI oidc-provider will redirect the user-agent to. `Configuration`'s
      // index signature (`[key: string]: unknown`) can't propagate parameter
      // types into this nested function, so they're annotated explicitly
      // (only `interaction.uid` is actually used).
      url(_ctx: unknown, interaction: { uid: string }) {
        return `/oauth-consent?uid=${interaction.uid}`;
      },
    },
    // `cookies.short.path` is normally unset, and oidc-provider derives the
    // `_interaction` cookie's `Set-Cookie: path=` from `interactions.url()`'s
    // *pathname only* (`/oauth-consent`) — see
    // node_modules/oidc-provider/lib/actions/authorization/interactions.js.
    // That scopes the cookie so the browser only sends it back on requests
    // under `/oauth-consent`, which would silently break the consent flow:
    // the client form's `fetch()` calls to `/api/v1/oauth/interaction` and
    // `/api/v1/oauth/consent-decision` (Task 5) are outside that path, so
    // `interactionDetails`/`interactionResult` would throw
    // `SessionNotFound: interaction session id cookie not found` for every
    // real browser request — confirmed by a live manual repro against
    // oidc-provider@9.9.1 during Task 5 implementation. Setting `path: '/'`
    // here widens the cookie to the whole origin so both the consent page
    // and its API routes receive it. (The `_interaction_resume` cookie is
    // unaffected — its own `path` is set *after* spreading `cookies.short`
    // in oidc-provider's source, so it always wins regardless of this.)
    cookies: {
      short: { path: '/' },
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
