// oidc-provider@9.x ships as ESM-only with no bundled type declarations, and
// no matching @types/oidc-provider package exists for this major version.
// This is a minimal ambient declaration covering the surface this codebase
// uses (see src/lib/mcp/oauth-provider.ts) — not a full port of the library's
// configuration schema.
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'http';

  export interface Configuration {
    [key: string]: unknown;
  }

  // Shape of the object `provider.interactionDetails()` resolves with (an
  // oidc-provider `Interaction` model instance). Only the fields this codebase
  // actually reads are typed; everything else falls through `[key: string]:
  // unknown` rather than pretending to be a full port of the library's model.
  export interface InteractionDetails {
    uid: string;
    params: Record<string, unknown>;
    grantId?: string;
    lastSubmission?: Record<string, unknown>;
    session?: { accountId?: string; uid?: string };
    [key: string]: unknown;
  }

  export interface InteractionResult {
    login?: { accountId: string; [key: string]: unknown };
    consent?: { grantId?: string; [key: string]: unknown };
    error?: string;
    error_description?: string;
    [key: string]: unknown;
  }

  // A Grant model instance (node_modules/oidc-provider/lib/models/grant.js).
  // Must be created (accountId + clientId), have scope added, and be saved
  // BEFORE its id can be referenced from an InteractionResult's
  // `consent.grantId` — oidc-provider does not create/persist one for you.
  export interface GrantInstance {
    addOIDCScope(scope: string): void;
    save(...args: unknown[]): Promise<string>;
    [key: string]: unknown;
  }

  // An AccessToken model instance
  // (node_modules/oidc-provider/lib/models/access_token.js +
  // .../base_token.js). `find()` (base_model.js) resolves `undefined` if the
  // token doesn't exist, is malformed, or has expired (expiration is checked
  // as part of `verify()`, which throws internally and is swallowed) —
  // otherwise an instance built from the adapter-stored payload, restricted
  // to the `IN_PAYLOAD` allow-list (`accountId`, `clientId`, `scope`,
  // `grantId`, `sid`, ... — only the two fields this codebase reads are
  // typed here).
  export interface AccessTokenInstance {
    accountId: string;
    clientId: string;
    [key: string]: unknown;
  }

  export class Provider {
    constructor(issuer: string, configuration?: Configuration);
    readonly issuer: string;
    // Real Node request handler — see oidc-provider's Koa `app.callback()`.
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    // Reads the interaction referenced by the signed `_interaction` cookie on
    // `req` — never writes to `res`. See `interaction_policy`/cookie
    // verification notes in oauth-provider.ts and consent-decision/route.ts.
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<InteractionDetails>;
    // Persists `result` onto the interaction (via the configured adapter) and
    // resolves with the URL to redirect the user-agent to next. Like
    // `interactionDetails`, does not write to `res`.
    interactionResult(
      req: IncomingMessage,
      res: ServerResponse,
      result: InteractionResult,
      options?: { mergeWithLastSubmission?: boolean }
    ): Promise<string>;
    // Dynamically generated per-provider Grant model class
    // (node_modules/oidc-provider/lib/models/grant.js) — constructed with a
    // fresh accountId/clientId, or looked up by a previously-saved id.
    Grant: {
      new (payload: { accountId: string; clientId: string }): GrantInstance;
      find(id: string): Promise<GrantInstance>;
    };
    // Dynamically generated per-provider AccessToken model class
    // (node_modules/oidc-provider/lib/models/access_token.js), lazily
    // instantiated by the real `Provider#AccessToken` getter
    // (node_modules/oidc-provider/lib/provider.js) — same pattern as `Grant`
    // above. `find()` returns `undefined` for a missing/malformed/expired
    // token; see `AccessTokenInstance` above for what a hit resolves with.
    AccessToken: {
      find(
        token: string,
        options?: { ignoreExpiration?: boolean }
      ): Promise<AccessTokenInstance | undefined>;
    };
    [key: string]: unknown;
  }

  export default Provider;
}
