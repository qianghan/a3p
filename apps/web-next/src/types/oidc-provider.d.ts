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

  export class Provider {
    constructor(issuer: string, configuration?: Configuration);
    readonly issuer: string;
    // Real Node request handler — see oidc-provider's Koa `app.callback()`.
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    [key: string]: unknown;
  }

  export default Provider;
}
