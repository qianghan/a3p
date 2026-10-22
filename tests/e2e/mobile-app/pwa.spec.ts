import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOBILE_VIEWPORT, loginAs, neverCachePaths } from './helpers';
import { SEL } from './selectors';

/**
 * Spec 8.3 PWA: manifest/installability, the DEPLOYED service worker's caches, notification default and offline
 * fallback, and that a client controlled by an OLD worker ends up on the NEW bundle (controllerchange path and the
 * unregister-and-reload path).
 *
 * The service worker MUST run here, so serviceWorkers stays 'allow' and nothing is routed (page.route cannot see
 * requests a worker answers). This is the only spec that allows it. It writes nothing: it signs in and reads.
 *
 * A first registration claims the page and the shell reloads ONCE on controllerchange, so every test boots through
 * `boot()`, which waits for that reload to finish before it starts measuring.
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'allow' });

const PAGE_CHUNK = /\/_next\/static\/chunks\/app\/app\/page-[A-Za-z0-9_-]+\.js/g;

/** An evaluate that survives the page reloading underneath it (the shell's controllerchange reload). */
async function tryEval<T>(page: Page, fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await page.evaluate(fn);
  } catch {
    return fallback; // execution context destroyed mid-reload: the caller polls again
  }
}

async function servedChunks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...new Set(
      performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname)
        .filter((p) => /\/_next\/static\/chunks\/app\/app\/page-[A-Za-z0-9_-]+\.js$/.test(p)),
    )]);
}
async function networkChunks(page: Page): Promise<string[]> {
  const html = await page.evaluate(async () => (await fetch(`/app?e2e=${Date.now()}`, { cache: 'no-store', credentials: 'include' })).text());
  return [...new Set([...html.matchAll(PAGE_CHUNK)].map((m) => m[0]))];
}


/**
 * The app's own hydrator logs 'Error fetching user: TypeError: Failed to fetch' when a request it has in flight is
 * aborted by something this spec does ON PURPOSE (cutting the network, or reloading the page mid-request). Forgive
 * exactly that line; any other console error still fails the test.
 */
function forgiveAbortedUserFetch(errors: { console: string[] }) {
  for (let i = errors.console.length - 1; i >= 0; i--) {
    if (/^Error fetching user: TypeError: Failed to fetch/.test(errors.console[i])) errors.console.splice(i, 1);
  }
}

/** Sign in, open /app, and wait until a worker controls the page and any claim-triggered reload has settled. */
async function boot(page: Page, errors: { console: string[] }) {
  await loginAs(page, 'maya');
  await page.goto('/app');
  await expect.poll(() => tryEval(page, () => !!navigator.serviceWorker.controller, false), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(3000); // a claim-triggered controllerchange reload lands inside this window
  await page.waitForLoadState('load');
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  errors.console.length = 0; // setup noise only (login page probes, the worker's claim + reload); the test bodies stay strict
}

test('manifest is installable and every icon and shortcut resolves', async ({ page, errors }) => {
  const res = await page.request.get('/manifest.json');
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m.start_url).toBe('/app');
  expect(m.display).toBe('standalone');
  const sizes = (m.icons ?? []).map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const i of m.icons ?? []) expect((await page.request.get(i.src)).status(), `icon ${i.src}`).toBe(200);
  expect((m.shortcuts ?? []).length).toBeGreaterThan(0);
  for (const s of m.shortcuts ?? []) {
    expect(String(s.url), 'shortcut stays inside the mobile app').toMatch(/^\/app(\/|$)/);
    const r = await page.request.get(s.url, { maxRedirects: 0 });
    expect([200, 307, 308], `shortcut ${s.url}`).toContain(r.status()); // 307/308 = sent to sign-in, never a 404
  }
});

test('deployed sw.js: revalidated, notification default is /app, no stale caches survive, and the never-cache routes are never cached', async ({ page, errors }) => {
  const res = await page.request.get('/sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control'] ?? '', 'sw.js must be revalidated on every check').toMatch(/max-age=0|no-cache|must-revalidate/);
  const sw = await res.text();

  // The notification default: an installed-app user belongs in /app, never on the desktop /agentbook.
  const handler = sw.slice(sw.indexOf("'notificationclick'"));
  expect(handler).toContain("'/app'");
  expect(handler).not.toMatch(/\|\|\s*['"]\/agentbook['"]/);

  // The worker's own purge rule: only STATIC_CACHE and API_CACHE survive activation.
  const staticName = /const STATIC_CACHE = '([^']+)'/.exec(sw)?.[1];
  const apiName = /const API_CACHE = '([^']+)'/.exec(sw)?.[1];
  expect(staticName && apiName, 'STATIC_CACHE and API_CACHE are declared').toBeTruthy();
  const never = neverCachePaths(sw);
  expect(never, 'NEVER_CACHE_PATHS parsed from the deployed worker').not.toBeNull();
  expect(never!).toContain('/api/v1/agentbook-core/mobile/home');
  expect(never!).toContain('/api/v1/agentbook-core/threads');

  await boot(page, errors);
  // Visit the screens that read the never-cache routes, so a violation would have something to cache.
  for (const p of ['/app', '/app/chat', '/app/docs']) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
  }
  const caches = await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const k of await window.caches.keys()) out[k] = (await (await window.caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  expect(Object.keys(caches).filter((k) => k !== staticName && k !== apiName), 'caches left over from an older worker version').toEqual([]);
  const cachedApi = caches[apiName!] ?? [];
  const leaked = cachedApi.filter(
    (p) => never!.includes(p) || /^\/api\/v1\/agentbook-core\/threads\/[^/]+\/turns$/.test(p),
  );
  expect(leaked, 'a compute-on-read route was written into the offline API cache').toEqual([]);
});

test('a client on an old worker reloads onto the new bundle, settles, and serves the deployed chunks', async ({ page, errors }) => {
  test.setTimeout(120_000);
  await boot(page, errors);
  let loads = 0;
  page.on('load', () => { loads += 1; });
  const tag = `e2e${Date.now()}`;
  // A different script URL is a new worker version: install -> skipWaiting -> clients.claim -> controllerchange ->
  // the shell's one-shot reload.
  await page.evaluate(async (tg) => { await navigator.serviceWorker.register(`/sw.js?v=${tg}`); }, tag);
  await expect.poll(() => loads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  // After that reload the shell re-registers the canonical /sw.js: one more legitimate version change, so at most one
  // more reload. Then it must settle for good.
  await page.waitForTimeout(8000);
  const settled = loads;
  expect(settled, 'reloads after a worker update (1 for the update, at most 1 for re-registration)').toBeLessThanOrEqual(2);
  await page.waitForTimeout(5000);
  expect(loads, 'no reload loop').toBe(settled);
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  const served = await servedChunks(page);
  const deployed = await networkChunks(page);
  expect(deployed.length, 'the deployed /app HTML references a page chunk (selector for this check)').toBeGreaterThan(0);
  expect(served.length, 'the page loaded a page chunk').toBeGreaterThan(0);
  expect(new Set(served)).toEqual(new Set(deployed));
});

test('unregister-and-reload lands on the deployed bundle with a fresh controller', async ({ page, errors }) => {
  test.setTimeout(120_000);
  await boot(page, errors);
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.reload();
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  await expect
    .poll(() => tryEval(page, async () => (await navigator.serviceWorker.getRegistrations()).length, 0), { timeout: 30_000 })
    .toBe(1);
  await expect.poll(() => tryEval(page, () => !!navigator.serviceWorker.controller, false), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(3000);
  await page.waitForLoadState('load');
  const deployed = await networkChunks(page);
  expect(deployed.length).toBeGreaterThan(0);
  expect(new Set(await servedChunks(page))).toEqual(new Set(deployed));
  forgiveAbortedUserFetch(errors); // the reload above aborts the hydrator's in-flight request
});

test.describe('offline behaviour of the live worker', () => {
  // strictErrors is OFF for this describe only: a fetch that fails because the device is offline makes the browser
  // log "Failed to load resource", which is the fault we injected. Page errors and rejections still fail the test.
  test.use({ strictErrors: false });

  test('offline: a cacheable API read gets the worker\'s labelled 503, a never-cache read fails outright (never a stale 200)', async ({ page, context, errors }) => {
    await boot(page, errors);
    const swSource = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'web-next', 'public', 'sw.js'), 'utf8');
    expect(swSource).toContain('X-Agentbook-Offline'); // the repo's worker is the one that is deployed
    try {
      await context.setOffline(true);
      const probe = await page.evaluate(async () => {
        const unique = `/api/v1/agentbook-expense/expenses?limit=1&e2e=${Date.now()}`;
        const r = await fetch(unique, { credentials: 'include' });
        let neverCacheThrew = false;
        let neverCacheStatus = 0;
        try {
          neverCacheStatus = (await fetch('/api/v1/agentbook-core/mobile/home', { credentials: 'include' })).status;
        } catch {
          neverCacheThrew = true;
        }
        return { status: r.status, marker: r.headers.get('X-Agentbook-Offline'), neverCacheThrew, neverCacheStatus };
      });
      expect(probe.status).toBe(503);
      expect(probe.marker, 'the worker labels its synthetic answer').toBe('1');
      expect(probe.neverCacheThrew, `a never-cache route answered ${probe.neverCacheStatus} offline instead of failing`).toBe(true);
    } finally {
      await context.setOffline(false);
      forgiveAbortedUserFetch(errors);
    }
  });
});
