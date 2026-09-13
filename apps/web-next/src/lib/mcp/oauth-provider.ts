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
 * - Unset: returns `undefined`, and oidc-provider then falls back to the
 *   keystore it ships in the package (`lib/consts/dev_keystore.js`). That is
 *   NOT a per-process random key — it is a fixed private key published on npm,
 *   the same one in every install on earth. Fine for local dev, forgeable by
 *   anyone in production, so we log a one-time warning.
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
        '[mcp/oauth-provider] AGENTBOOK_MCP_JWKS is not set — falling back to the DEV keystore ' +
          'that ships inside the oidc-provider package (lib/consts/dev_keystore.js). That private ' +
          'key is identical in every install and published on npm, so anything this server signs ' +
          'can be forged by anyone. Fine for local dev; production MUST set AGENTBOOK_MCP_JWKS ' +
          '(a JSON-stringified JWK Set, e.g. { "keys": [...] }).'
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
    // WHY THIS OVERRIDE EXISTS — it is not a policy tweak, it is what makes
    // the refresh_token grant EXIST at all.
    //
    // oidc-provider only adds `refresh_token` to its enabled grant types when
    // either the `offline_access` scope is configured or `issueRefreshToken`
    // differs from its default (helpers/configuration.js: `if
    // (this.scopes.has('offline_access') || this.issueRefreshToken !==
    // this.#defaults.issueRefreshToken)`). We have neither `offline_access`
    // nor, previously, an override — so the grant was silently absent, and:
    //
    //   - Dynamic Client Registration REJECTED every client that asked for it
    //     with `400 invalid_client_metadata: grant_types can only contain
    //     'implicit' or 'authorization_code'`. Gemini CLI registers exactly
    //     `['authorization_code', 'refresh_token']`
    //     (@google/gemini-cli-core/dist/src/mcp/oauth-provider.js), so it could
    //     not connect at all — not degraded, refused at the first request.
    //   - A client that registered without it got an access token good for the
    //     one hour in `ttl` below and no way to renew, so the connector died
    //     hourly and needed a fresh browser consent each time.
    //   - `/.well-known/oauth-authorization-server` advertised
    //     `grant_types_supported: ['authorization_code', 'refresh_token']`
    //     the whole time, which was simply untrue.
    //   - `ttl.RefreshToken` below was dead configuration.
    //
    // The default helper additionally requires `offline_access` in the granted
    // scopes, which an MCP client asking for `agentbook:full` never sends —
    // so delegating to it would re-create the same silence one layer down.
    // Issue whenever the client registered for the grant.
    issueRefreshToken: async (_ctx: unknown, client: { grantTypeAllowed(t: string): boolean }) =>
      client.grantTypeAllowed('refresh_token'),
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
