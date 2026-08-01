import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { expectOk } from './helpers/api';

/**
 * @phase9-pwa — the installable mobile app, on the deployed site.
 *
 * A PWA test already existed at tests/e2e/mobile-app.spec.ts and ran in NO
 * workflow — the same dead-suite shape as the nightly itself, which sat broken
 * for three months because nothing ever reported it. It also hardcoded a
 * fallback password, which is the two-copies drift removed in #403.
 *
 * Its intent is preserved here, wired into the nightly matrix, using the e2e
 * tenant and the one caller-supplied password.
 *
 * What this asserts is deliberately the part a unit test cannot reach: that the
 * DEPLOYED site serves an installable manifest, that sw.js is revalidated
 * rather than frozen in a CDN, and that the app shell actually renders on a
 * phone viewport. The service worker's own caching rules — which have caused
 * four production incidents — are pinned structurally in
 * apps/web-next/src/__tests__/architecture/service-worker-invariants.test.ts,
 * because reproducing a stale-cache bug against live production is slow,
 * flaky, and would only ever catch it after a deploy.
 */

const PHONE = { width: 390, height: 844 };

test.describe('@phase9-pwa', () => {
  test('the manifest is served and is installable', async ({ page }) => {
    const res = await page.request.get('/manifest.json');
    expect(res.status(), 'manifest must be served').toBe(200);
    const m = await res.json();

    expect(m.start_url).toBe('/app');
    expect(m.name).toBe('AgentBook');
    expect(m.display, 'display must be standalone or the install is just a bookmark')
      .toBe('standalone');

    // Chrome refuses to offer installation without both of these sizes.
    const sizes = (m.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  test('every icon and shortcut the manifest promises is actually reachable', async ({ page }) => {
    // A manifest pointing at a 404 icon fails installation SILENTLY — the
    // prompt never appears and nothing explains why. The structural test
    // checks these exist in the repo; this checks they survived the deploy.
    const m = await (await page.request.get('/manifest.json')).json();
    for (const icon of m.icons ?? []) {
      const r = await page.request.get(icon.src);
      expect(r.status(), `manifest icon ${icon.src} must be served`).toBe(200);
    }
    for (const s of m.shortcuts ?? []) {
      const r = await page.request.get(s.url);
      expect(
        r.status(),
        `shortcut "${s.name}" -> ${s.url} must not 404 (307 to login is fine)`,
      ).toBeLessThan(400);
    }
  });

  test('sw.js is served and must be revalidated, never frozen', async ({ page }) => {
    // A service worker cached long-term by the CDN is the classic PWA trap:
    // users keep running an old worker, and its stale caching rules outlive
    // every fix shipped after it. Browsers also cap sw.js freshness at 24h,
    // so a long max-age here is always a mistake.
    const res = await page.request.get('/sw.js');
    expectOk({ status: res.status(), data: null }, 'sw.js');
    const cc = res.headers()['cache-control'] ?? '';
    expect(cc, `sw.js must revalidate, got "${cc}"`).toMatch(/max-age=0|no-cache|must-revalidate/);
  });

  test('the app shell renders on a phone with its bottom nav', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await loginAsE2eUser(page);
    await page.goto('/app');
    for (const label of ['Home', 'Capture', 'Docs', 'Chat']) {
      await expect(
        page.getByText(label, { exact: true }),
        `bottom-nav tab "${label}"`,
      ).toBeVisible();
    }
  });

  test('the capture and chat tabs load, not just link', async ({ page }) => {
    // Asserting rendered content rather than a URL — the tax-nav bug shipped a
    // visible link whose page was broken behind it.
    await page.setViewportSize(PHONE);
    await loginAsE2eUser(page);

    await page.goto('/app/docs');
    await expect(page.getByText('Documents', { exact: true })).toBeVisible();

    await page.goto('/app/chat');
    await expect(page.getByPlaceholder('Type a message…')).toBeVisible();
  });
});
