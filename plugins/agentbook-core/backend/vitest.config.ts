import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Task 3 (PR-3, tax fast-track foundation): agent-brain.ts now imports
 * `@agentbook/jurisdictions/tax-questionnaire-loader` — a deep subpath import
 * of a workspace package that has no `exports` map in its package.json (it
 * only declares `"main": "./src/index.ts"`).
 *
 * Vite/vitest's default resolver only resolves a bare package specifier's
 * ROOT (via `main`) without an explicit alias — a root-only import like
 * `@agentbook/jurisdictions` already worked fine under vitest elsewhere in
 * this monorepo (e.g. agentbook-startup/backend), but a deep subpath like
 * `@agentbook/jurisdictions/tax-questionnaire-loader` does not resolve
 * without this alias, even though the exact same subpath-import pattern
 * (`@agentbook/jurisdictions/past-filing-loader`) already existed in
 * tax-past-filings.ts before this PR — that pre-existing usage just never
 * hit this problem because no test file happened to import it. This is the
 * first test suite to actually exercise a deep-subpath `@agentbook/jurisdictions/*`
 * import, so it's the first to need this alias.
 *
 * Mirrors the same `resolve.alias` pattern apps/web-next/vitest.config.ts
 * already uses for other workspace packages (e.g. `@naap/ui`) — plugin-alias
 * prefix-matches a plain string key against `key` or `key/...`, so this one
 * alias covers both the bare import and any deep subpath.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@agentbook/jurisdictions': path.resolve(__dirname, '../../../packages/agentbook-jurisdictions/src'),
    },
  },
});
