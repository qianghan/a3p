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

describe('mobile /app route budgets (spec 2026-10-07 §8.3: baseline + 40 kB gz)', () => {
  const MOBILE_SAMPLE = `
┌ ○ /app                                                                        3.10 kB         210 kB
├ ○ /app/capture                                                                2.00 kB         205 kB
├ ○ /app/chat                                                                   1.50 kB         204 kB
├ ○ /app/docs                                                                   1.90 kB         205 kB
├ ƒ /app/docs/[id]                                                              4.00 kB         240 kB
`;
  const baseline = {
    commit: 'a'.repeat(40), measuredAt: '2026-10-07', method: 'test', unit: 'kB', allowanceKb: 40,
    routes: { '/app': 200, '/app/capture': 200, '/app/chat': 200, '/app/docs': 200 },
    inheritFrom: { '/app/docs/[id]': '/app/docs' },
  };

  it('budget = baseline + allowance; new routes inherit their parent', async () => {
    const { mobileBudgets } = await import(GUARD);
    expect(mobileBudgets(baseline)).toEqual({
      '/app': 240, '/app/capture': 240, '/app/chat': 240, '/app/docs': 240, '/app/docs/[id]': 240,
    });
  });

  it('passes at the budget, fails above it, fails when a route is missing', async () => {
    const { parseRoutes, checkMobileRoutes } = await import(GUARD);
    expect(checkMobileRoutes(parseRoutes(MOBILE_SAMPLE), baseline)).toEqual([]);
    const over = MOBILE_SAMPLE.replace('204 kB', '241 kB');
    expect(checkMobileRoutes(parseRoutes(over), baseline).join('\n')).toMatch(/\/app\/chat: First Load JS 241 kB exceeds mobile budget 240 kB/);
    const missing = MOBILE_SAMPLE.split('\n').filter((l) => !l.includes('/app/chat')).join('\n');
    expect(checkMobileRoutes(parseRoutes(missing), baseline).join('\n')).toMatch(/\/app\/chat: missing from the build table/);
  });

  it('also bounds the shared runtime baseline, so cost cannot hide in the shared manifest', async () => {
    const { parseRoutes, checkMobileRoutes } = await import(GUARD);
    const withShared = { ...baseline, sharedKb: 100 };
    const routes = parseRoutes(MOBILE_SAMPLE);
    expect(checkMobileRoutes(routes, withShared, 140)).toEqual([]);
    expect(checkMobileRoutes(routes, withShared, 141).join('\n')).toMatch(/shared First Load JS 141 kB exceeds mobile budget 140 kB/);
  });

  it('records a baseline from a build log', async () => {
    const { recordMobileBaseline } = await import(GUARD);
    const b = recordMobileBaseline(MOBILE_SAMPLE, 'b'.repeat(40), '2026-10-07T00:00:00Z');
    expect(b.routes).toEqual({ '/app': 210, '/app/capture': 205, '/app/chat': 204, '/app/docs': 205 });
    expect(b.allowanceKb).toBe(40);
    expect(b.inheritFrom).toEqual({ '/app/docs/[id]': '/app/docs' });
    const withShared = recordMobileBaseline(MOBILE_SAMPLE + '+ First Load JS shared by all   103 kB\n', 'b'.repeat(40), 'x');
    expect(withShared.sharedKb).toBe(103);
  });

  it('the committed baseline is real (measured, four routes, a commit sha)', () => {
    const file = join(ROOT, 'bin', 'perf-baseline-mobile.json');
    expect(existsSync(file)).toBe(true);
    const b = JSON.parse(readFileSync(file, 'utf8'));
    expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(b.routes).sort()).toEqual(['/app', '/app/capture', '/app/chat', '/app/docs']);
    for (const v of Object.values(b.routes)) expect(v as number).toBeGreaterThan(80);
    expect(b.allowanceKb).toBe(40);
  });
});


describe('mobile budget overrides (a raised budget must carry its reason)', () => {
  const base = {
    allowanceKb: 40,
    sharedKb: 103,
    routes: { '/app': 105, '/app/docs': 135 },
    inheritFrom: { '/app/docs/[id]': '/app/docs' },
  };
  const withOverride = {
    ...base,
    overrides: { '/app': { allowanceKb: 60, reason: 'Home grew with the KPI strip and alert carousel; ratcheted at measured + 5 kB.' } },
  };

  it('an override replaces the allowance for that route only', async () => {
    const { mobileBudgets } = await import(GUARD);
    expect(mobileBudgets(withOverride)).toEqual({ '/app': 165, '/app/docs': 175, '/app/docs/[id]': 175 });
  });

  it('without an override the default allowance applies', async () => {
    const { mobileBudgets } = await import(GUARD);
    expect(mobileBudgets(base)).toEqual({ '/app': 145, '/app/docs': 175, '/app/docs/[id]': 175 });
  });

  it('an override with no reason is rejected, not silently accepted', async () => {
    const { mobileBudgets } = await import(GUARD);
    const bad = { ...base, overrides: { '/app': { allowanceKb: 60, reason: '  ' } } };
    expect(() => mobileBudgets(bad)).toThrow(/reason/i);
  });

  it('an override for a route the baseline does not know is rejected', async () => {
    const { mobileBudgets } = await import(GUARD);
    const bad = { ...base, overrides: { '/app/nope': { allowanceKb: 60, reason: 'x' } } };
    expect(() => mobileBudgets(bad)).toThrow(/unknown route/i);
  });

  it('a route over its overridden budget still fails', async () => {
    const { checkMobileRoutes } = await import(GUARD);
    const routes = [{ route: '/app', firstLoadKb: 166 }, { route: '/app/docs', firstLoadKb: 140 }, { route: '/app/docs/[id]', firstLoadKb: 150 }];
    expect(checkMobileRoutes(routes, withOverride, 103).join('\n')).toMatch(/\/app: First Load JS 166 kB exceeds mobile budget 165 kB/);
  });
});

describe('the committed mobile overrides file', () => {
  it('is valid against the committed baseline, and every override says why', async () => {
    const { mobileBudgets } = await import(GUARD);
    const root = join(__dirname, '..', '..', '..', '..', '..', 'bin');
    const baseline = JSON.parse(readFileSync(join(root, 'perf-baseline-mobile.json'), 'utf8'));
    const { _comment, ...overrides } = JSON.parse(readFileSync(join(root, 'perf-mobile-overrides.json'), 'utf8'));
    expect(typeof _comment).toBe('string');
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    for (const [route, o] of Object.entries(overrides) as Array<[string, { reason: string }]>) {
      expect(o.reason.length, `${route} reason`).toBeGreaterThan(40);
    }
    expect(() => mobileBudgets({ ...baseline, overrides })).not.toThrow();
  });
});
