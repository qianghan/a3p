import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * server.ts (and tax-past-filings.ts, which it imports) uses a deep
 * subpath import of a workspace package that has no `exports` map in its
 * package.json (it only declares `"main": "./src/index.ts"`):
 * `@agentbook/jurisdictions/past-filing-loader`.
 *
 * Vite/vitest's default resolver only resolves a bare package specifier's
 * ROOT (via `main`) without an explicit alias — a root-only import like
 * `@agentbook/jurisdictions` already worked fine under vitest elsewhere in
 * this monorepo, but a deep subpath does not resolve without this alias.
 * This is the first test suite in this plugin to actually import
 * server.ts (added alongside the tenant-middleware auth-hardening test),
 * so it's the first to need this alias here — mirroring the identical
 * alias already added in plugins/agentbook-core/backend/vitest.config.ts
 * for the same underlying resolution gap.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@agentbook/jurisdictions': path.resolve(__dirname, '../../../packages/agentbook-jurisdictions/src'),
    },
  },
});
