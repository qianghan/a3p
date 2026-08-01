import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Service-worker invariants — the four shipped incidents, pinned.
 *
 * public/sw.js is a plain static asset. It is not bundled, not typechecked,
 * not imported by anything, and until now not tested. It is also the single
 * piece of code that can break EVERY page at once, because it sits in front of
 * the network for every request the installed app makes.
 *
 * Its comments record four separate production incidents:
 *
 *   1. infinite loading loop — a cached HTML shell referencing content-hashed
 *      chunks that 404 after the next deploy
 *   2. PWA Google sign-in loop — a cached navigation response holding a stale
 *      pre-auth redirect
 *   3. duplicate expense writes — `cache.put()` throws on a POST, the throw
 *      escaped into the offline branch, and the client was told a mutation had
 *      failed when the server had in fact succeeded, so it queued a replay
 *   4. stale money — compute-on-read tax figures served from cache after new
 *      expenses landed
 *
 * Every one of those is a single careless edit away from returning, and the
 * only thing currently preventing it is the comments. Comments are not
 * enforcement — that lesson cost an unauthenticated-write hole earlier today,
 * where `// production has it off` was the entire safety argument.
 *
 * Structural, deliberately: the alternative is standing up a full service
 * worker harness, and these assertions catch the actual regressions for a
 * fraction of that. Each was verified by reintroducing the bug.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SW_PATH = 'apps/web-next/public/sw.js';
const MANIFEST_PATH = 'apps/web-next/public/manifest.json';

const swSource = readFileSync(join(ROOT, SW_PATH), 'utf8');

/** Source with comments stripped. A guard must match code, not prose about code. */
const swCode = swSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the service worker never serves a cached HTML document', () => {
  it('navigation requests go to the network', () => {
    // Incidents 1 and 2. A navigation served from cache can carry both a stale
    // chunk manifest and a stale auth redirect.
    //
    // Scoped to the navigate branch ONLY, ending at its closing brace. The
    // first version took a flat 200-character window, which ran past the
    // branch and matched the DEFAULT branch's `respondWith(fetch(...))` just
    // below — so swapping the navigate branch to cacheFirst still passed.
    // Mutation testing is the only reason that was caught; the guard read
    // perfectly well.
    const navStart = swCode.indexOf("request.mode === 'navigate'");
    expect(navStart, 'the navigate branch must exist').toBeGreaterThan(-1);
    const navBranch = swCode.slice(navStart, swCode.indexOf('}', navStart));
    expect(navBranch, 'the navigate branch must fetch').toMatch(/respondWith\(\s*fetch\(/);
    expect(navBranch, 'the navigate branch must not touch any cache')
      .not.toMatch(/cacheFirst|caches\.match|networkFirstWithCache/);
  });

  it('no HTML document is pre-cached', () => {
    // PRECACHE_URLS holding '/agentbook' or '/app' is how incident 1 started.
    const precache = swCode.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
    expect(precache, 'PRECACHE_URLS must exist').toBeTruthy();
    const entries = (precache![1].match(/'[^']*'/g) ?? []).map((s) => s.slice(1, -1));
    for (const e of entries) {
      expect(
        /\.(json|css|js|png|svg|woff2?|ico)$/.test(e),
        `precached "${e}" is not a static asset — precaching a navigable document is incident #1`,
      ).toBe(true);
    }
  });
});

describe('the service worker never caches a mutation', () => {
  it('only GET responses are written to the API cache', () => {
    // Incident 3. `cache.put()` throws on POST; the throw escaping into the
    // catch told the client a successful write had failed, which produced a
    // duplicate expense on replay.
    //
    // Asserted at the WRITE SITE, not file-wide. The first version just looked
    // for `request.method === 'GET'` anywhere in the file, which the catch
    // block below also satisfies — so deleting the guard from the cache-write
    // condition still passed.
    const netFirst = swCode.slice(swCode.indexOf('async function networkFirstWithCache'));
    const writeSite = netFirst.slice(0, netFirst.indexOf('} catch'));
    expect(writeSite, 'the cache write must be gated on GET')
      .toMatch(/response\.ok\s*&&\s*request\.method\s*===\s*'GET'/);
  });

  it('a cache-write failure can never be reported as a network failure', () => {
    // The `.catch(() => {})` on the cache.put chain is load-bearing, not
    // defensive noise: without it the rejection lands in the offline branch.
    const netFirst = swCode.slice(swCode.indexOf('async function networkFirstWithCache'));
    expect(netFirst, 'cache.put must swallow its own errors')
      .toMatch(/cache\.put\([\s\S]{0,80}?\)\s*\)\s*\.catch\(/);
  });

  it('the offline fallback is only used for GET', () => {
    const netFirst = swCode.slice(swCode.indexOf('async function networkFirstWithCache'));
    const catchBlock = netFirst.slice(netFirst.indexOf('} catch'));
    expect(catchBlock, 'a non-GET must not be answered from cache')
      .toMatch(/request\.method\s*===\s*'GET'/);
  });
});

describe('compute-on-read money is never served stale', () => {
  it('the live tax estimate is excluded from the API cache', () => {
    // Incident 4. A cached estimate keeps showing figures that no longer match
    // the ledger after new expenses land — misleading, not harmlessly stale.
    expect(swCode).toMatch(/NEVER_CACHE_PATHS/);
    expect(swCode).toMatch(/agentbook-tax\/tax\/estimate/);
  });

  it('excluded routes bypass the cache entirely rather than falling through', () => {
    const guard = swCode.slice(swCode.indexOf('isExcludedFromApiCache(url.pathname)'));
    expect(guard.slice(0, 160), 'an excluded route must go straight to fetch')
      .toMatch(/respondWith\(\s*fetch\(/);
  });

  it('binary downloads are excluded too', () => {
    expect(swCode).toMatch(/BINARY_DOWNLOAD_PATTERNS/);
  });
});

describe('the manifest stays installable', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8'));

  it('declares the fields a browser requires to offer installation', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBe('standalone');
  });

  it('ships both 192 and 512 icons, including maskable', () => {
    // Chrome refuses the install prompt without a 192 and a 512. A maskable
    // icon is what stops Android cropping the logo into a circle.
    const sizes = (manifest.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    const maskable = (manifest.icons ?? []).filter(
      (i: { purpose?: string }) => i.purpose === 'maskable',
    );
    expect(maskable.length, 'at least one maskable icon').toBeGreaterThan(0);
  });

  it('every icon file it references actually exists', () => {
    // A manifest pointing at a missing icon fails installation silently — the
    // prompt simply never appears, with nothing in the UI to explain why.
    for (const icon of manifest.icons ?? []) {
      const p = join(ROOT, 'apps/web-next/public', icon.src);
      expect(existsSync(p), `manifest references missing icon ${icon.src}`).toBe(true);
    }
  });

  it('every shortcut points at a route that exists', () => {
    for (const s of manifest.shortcuts ?? []) {
      const route = String(s.url).replace(/^\//, '');
      const page = join(ROOT, 'apps/web-next/src/app', route, 'page.tsx');
      expect(existsSync(page), `shortcut "${s.name}" points at missing route ${s.url}`).toBe(true);
    }
  });
});
