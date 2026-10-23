import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { MOBILE_VIEWPORT, loginAs, settle } from './helpers';
import { SEL } from './selectors';

/**
 * Spec §8.3 performance. Throttling = Chrome DevTools "Slow 4G" (562.5 ms RTT,
 * 1474.56 kbps down, 675 kbps up) + 4x CPU slowdown (Lighthouse mobile profile).
 * GATE = repeat visit (HTTP cache warm), which is what an installed PWA user
 * experiences. The cold, cache-disabled load is measured and attached to the
 * report as information, not gated — stated here so nobody mistakes it.
 *
 * No text is asserted, so Maya's French rendering does not matter here; the
 * gates are numeric (time, CLS) and structural (testids, image URLs).
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const SLOW_4G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: Math.round((1474.56 * 1024) / 8),
  uploadThroughput: Math.round((675 * 1024) / 8),
};
const KPI_IDS = [SEL.home.kpiMonthNet, SEL.home.kpiCash, SEL.home.kpiOutstanding, SEL.home.kpiTax];

async function throttle(page: Page, cacheDisabled: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled });
  await cdp.send('Network.emulateNetworkConditions', SLOW_4G);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return cdp;
}

async function kpisVisibleAt(page: Page): Promise<number> {
  await page.goto('/app', { waitUntil: 'commit' });
  const h = await page.waitForFunction(
    (ids: string[]) => {
      // Ready = every KPI tile is on screen, the loading skeleton is gone, and at least one tile carries a real
      // number. NOT 'every tile has a digit': a tile is legitimately unavailable (shows a dash) when the tenant has
      // no data for it, e.g. Maya has no records in the current month, so 'Net this month' is a dash.
      const tiles = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
      const allThere = tiles.every((el) => !!el);
      const loading = !!document.querySelector('[data-testid="home-skeleton"]');
      const hasNumber = tiles.some((el) => !!el && /\d/.test(el.textContent || ''));
      return allThere && !loading && hasNumber ? performance.now() : false;
    },
    KPI_IDS,
    { timeout: 30_000, polling: 50 },
  );
  return (await h.jsonValue()) as number;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('Home shows its 4 KPIs within 2.5 s on Slow 4G + 4x CPU (repeat visit), and responds to a tap', async ({ page, errors }, testInfo) => {
  await loginAs(page, 'maya');
  await settle(page);
  errors.console.length = 0; // sign-in noise only (login page's unauthenticated probes); the measured visits stay strict
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.kpiTax)).toBeVisible(); // warm the function + HTTP cache
  await throttle(page, false);
  const samples = [await kpisVisibleAt(page), await kpisVisibleAt(page), await kpisVisibleAt(page)];
  await testInfo.attach('home-kpi-ms.json', { body: JSON.stringify({ samples, median: median(samples) }), contentType: 'application/json' });
  expect(median(samples), `KPI-visible samples ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(2500);
  const t0 = Date.now();
  await page.getByTestId(SEL.home.kpiTax).click();
  await expect(page.getByTestId(SEL.home.kpiSheet)).toBeVisible({ timeout: 1000 });
  await testInfo.attach('kpi-tap-ms.json', { body: JSON.stringify({ ms: Date.now() - t0 }), contentType: 'application/json' });
});

test('cold load (cache disabled) — measured for the report, not gated', async ({ page, errors }, testInfo) => {
  await loginAs(page, 'maya');
  await settle(page);
  errors.console.length = 0; // sign-in noise only (login page's unauthenticated probes); the measured visits stay strict
  await throttle(page, true);
  const ms = await kpisVisibleAt(page);
  await testInfo.attach('home-kpi-cold-ms.json', { body: JSON.stringify({ ms }), contentType: 'application/json' });
  expect(ms).toBeGreaterThan(0);
});

test('Docs list scrolls without layout shift and never loads full-size receipts', async ({ page, errors }, testInfo) => {
  const blobHits: string[] = [];
  page.on('request', (r) => { if (/\.blob\.vercel-storage\.com\//.test(r.url())) blobHits.push(r.url()); });
  await loginAs(page, 'maya');
  await settle(page);
  errors.console.length = 0; // sign-in noise only (login page's unauthenticated probes); the measured visits stay strict
  await page.goto('/app/docs');
  await page.getByTestId(`${SEL.docs.filterPrefix}all`).click();
  await expect(page.getByTestId(SEL.docs.row).first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });
  for (let i = 0; i < 12 && (await page.getByTestId(SEL.docs.row).count()) < 100; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(500);
  }
  const rows = await page.getByTestId(SEL.docs.row).count();
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  const imgs = await page.locator(`[data-testid="${SEL.docs.row}"] img`).evaluateAll((els) =>
    els.map((el) => {
      const img = el as HTMLImageElement;
      const w = new URL(img.currentSrc || img.src, location.href).searchParams.get('w');
      return {
        src: img.getAttribute('src') ?? '',
        w: w ? Number(w) : null,
        sized: !!(img.getAttribute('width') && img.getAttribute('height')) || !!img.style.width,
        loading: img.loading,
      };
    }),
  );
  await testInfo.attach('docs-scroll.json', { body: JSON.stringify({ rows, cls, images: imgs.length }), contentType: 'application/json' });
  expect(cls, 'cumulative layout shift while scrolling Docs').toBeLessThan(0.1);
  for (const i of imgs) {
    expect(i.src, 'thumbnails go through the Next image optimizer').toContain('/_next/image');
    expect(i.w ?? 9999, 'thumbnail width').toBeLessThanOrEqual(384);
    expect(i.sized, 'thumbnail has intrinsic size (no shift)').toBe(true);
  }
  expect(imgs.slice(6).every((i) => i.loading === 'lazy'), 'off-screen thumbnails are lazy').toBe(true);
  expect(blobHits, 'no full-size receipt fetched directly by the list').toEqual([]);
});
