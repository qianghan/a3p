import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The wiring that makes error reporting real, asserted at source.
 *
 * Before this, `@sentry/nextjs` was a dependency and `logger.reportError`
 * called `captureException` on it — but `Sentry.init()` was never called
 * anywhere in the repo, and an SDK with no client bound drops every event
 * silently. The pipe had never delivered anything and would not have even
 * with SENTRY_DSN set. The helper being named `sentryInitPromise` is what
 * made it look finished.
 *
 * That failure mode is invisible: no error, no warning, no test. These
 * assertions are the only thing standing between "we have error tracking"
 * and believing we do.
 */

const APP = join(__dirname, '..', '..');
const read = (f: string) => readFileSync(join(APP, f), 'utf8');

describe('Sentry is actually initialised', () => {
  it.each([
    'sentry.server.config.ts',
    'sentry.edge.config.ts',
  ])('%s calls Sentry.init', (f) => {
    expect(existsSync(join(APP, f)), `${f} is missing`).toBe(true);
    expect(read(f)).toMatch(/Sentry\.init\(/);
  });

  it('instrumentation.ts loads both runtime configs', () => {
    const src = read('instrumentation.ts');
    expect(src).toMatch(/export async function register/);
    // The edge runtime cannot load the Node transport, so loading the wrong
    // one is a runtime failure in middleware only — the least-tested path.
    expect(src).toContain('./sentry.server.config');
    expect(src).toContain('./sentry.edge.config');
    expect(src).toMatch(/NEXT_RUNTIME/);
  });

  it('instrumentation.ts exports onRequestError', () => {
    // Errors Next catches itself — thrown in a server component, a route
    // handler or during streaming — never reach our own try/catch. Without
    // this hook they are invisible however well reportError is wired.
    expect(read('instrumentation.ts')).toMatch(/export async function onRequestError/);
  });
});

describe('unconfigured means silent, not broken', () => {
  it.each([
    'sentry.server.config.ts',
    'sentry.edge.config.ts',
    'instrumentation-client.ts',
  ])('%s is gated on a DSN', (f) => {
    // Dev, CI and every deployment before the DSN is set must be a no-op —
    // not a warning on each boot, and not an attempt to reach an ingest host.
    expect(read(f)).toMatch(/if \(\s*(process\.env\.(NEXT_PUBLIC_)?SENTRY_DSN|dsn)\s*\)/);
  });

  it('the browser config reads the PUBLIC dsn, never the server secret', () => {
    const src = read('instrumentation-client.ts');
    expect(src).toContain('NEXT_PUBLIC_SENTRY_DSN');
    // Server env is not available in the browser, and inlining the server
    // variable name here would either be undefined or, worse, work.
    expect(src).not.toMatch(/process\.env\.SENTRY_DSN\b/);
  });
});

describe('the browser SDK stays out of the shared chunk', () => {
  it('instrumentation-client.ts imports Sentry dynamically', () => {
    const src = read('instrumentation-client.ts');
    // A static import puts ~35 kB gzip into the chunk shared by all 598
    // routes, against a 115 kB budget currently at 103 kB. bin/perf-budget.mjs
    // would fail the build — correctly — so this keeps the two consistent.
    expect(src).not.toMatch(/^import .* from '@sentry\/nextjs'/m);
    expect(src).toMatch(/import\(\s*'@sentry\/nextjs'\s*\)/);
  });

  it('next.config applies withSentryConfig only when configured', () => {
    const src = read('next.config.js');
    expect(src).toMatch(/withSentryConfig/);
    expect(src).toMatch(/process\.env\.SENTRY_DSN \|\| process\.env\.NEXT_PUBLIC_SENTRY_DSN/);
    // Source maps make a minified stack readable; leaving them served
    // publicly hands out the app's source.
    expect(src).toMatch(/deleteSourcemapsAfterUpload:\s*true/);
  });
});
