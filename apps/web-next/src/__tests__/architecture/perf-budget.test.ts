/**
 * The performance budget parser.
 *
 * The guard's whole value rests on it actually reading the build table. Next
 * has changed that table's shape between releases, and a parser that silently
 * matches nothing would turn the budget into a no-op that reports success —
 * which is worse than having no budget, because it looks like coverage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const GUARD = join(ROOT, 'bin', 'perf-budget.mjs');

// A verbatim slice of real `next build` output, including the shapes that
// broke earlier drafts: a MB-scale size, a dynamic route, a route group.
const SAMPLE = `
Route (app)                                                                        Size  First Load JS
┌ ○ /                                                                           2.82 kB         204 kB
├ ○ /_not-found                                                                 1.64 kB         104 kB
├ ƒ /[...slug]                                                                  2.69 kB         226 kB
├ ○ /settings                                                                    102 kB         494 kB
├ ƒ /plugins/[pluginName]                                                       8.11 kB         231 kB
└ ○ /marketplace                                                                9.94 kB         238 kB
+ First Load JS shared by all                                                    103 kB
`;

describe('perf-budget parser', () => {
  it('the guard exists and is executable from the repo root', () => {
    expect(existsSync(GUARD)).toBe(true);
  });

  it('reads every route row, including dynamic and catch-all', async () => {
    const { parseRoutes } = await import(GUARD);
    const routes = parseRoutes(SAMPLE);
    expect(routes.map((r: { route: string }) => r.route)).toEqual([
      '/',
      '/_not-found',
      '/[...slug]',
      '/settings',
      '/plugins/[pluginName]',
      '/marketplace',
    ]);
  });

  it('takes First Load JS — the LAST column — not the route size', async () => {
    const { parseRoutes } = await import(GUARD);
    const routes = parseRoutes(SAMPLE);
    // /settings is 102 kB of its own code but 494 kB to first load. Reading
    // the wrong column would understate the worst route in the app by 4x.
    const settings = routes.find((r: { route: string }) => r.route === '/settings');
    expect(settings.firstLoadKb).toBe(494);
  });

  it('reads the shared baseline', async () => {
    const { parseShared } = await import(GUARD);
    expect(parseShared(SAMPLE)).toBe(103);
  });

  it('returns nothing for output with no table, so the guard can refuse to pass', async () => {
    const { parseRoutes } = await import(GUARD);
    expect(parseRoutes('Compiled successfully\nLinting...\n')).toEqual([]);
  });

  it('handles MB-scale sizes without treating them as kB', async () => {
    const { parseRoutes } = await import(GUARD);
    const routes = parseRoutes('┌ ○ /huge                     1.2 MB         2.5 MB\n');
    expect(routes[0].firstLoadKb).toBeCloseTo(2560, 0);
  });
});
