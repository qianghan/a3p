import { test, expect } from '@playwright/test';
import {
  loginAs,
  settle,
  pageLocales,
  catalogT,
  expectScreen,
  tabNav,
  isLocalHost,
  loginUnavailableReason,
  applySafeAreaInsets,
  measureShell,
  IPHONE_INSETS,
  MOBILE_VIEWPORT,
  type ScreenRoute,
} from './helpers';

const ORDER = ['/app', '/app/docs', '/app/capture', '/app/chat'] as const;
const LABEL_KEY: Record<(typeof ORDER)[number], string> = {
  '/app': 'mobile.tabs.home',
  '/app/docs': 'mobile.tabs.docs',
  '/app/capture': 'mobile.tabs.capture',
  '/app/chat': 'mobile.tabs.chat',
};

test.describe('@mobile-shell', () => {
  test.describe('signed in', () => {
    // A local dev server has no seeded personas; say so instead of failing on a login that cannot work.
    test.beforeEach(({ baseURL }) => {
      const reason = loginUnavailableReason(baseURL);
      test.skip(reason !== null, reason ?? '');
    });

    for (const persona of ['maya', 'alex', 'sydney'] as const) {
      test(`${persona}: four tabs in order; each tab renders its screen without a full reload`, async ({ page }) => {
        await loginAs(page, persona);
        await page.goto('/app');
        await settle(page);
        const t = catalogT((await pageLocales(page)).stringLocale);
        const nav = tabNav(page, t);
        const links = nav.locator('a[data-tab]');
        await expect(links).toHaveCount(4);
        expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')))).toEqual([...ORDER]);
        for (const href of ORDER) await expect(nav.locator(`a[data-tab="${href}"]`)).toContainText(t(LABEL_KEY[href]));

        // A full page load wipes window state; client-side navigation keeps it.
        await page.evaluate(() => { (window as unknown as { __abNoReload: string }).__abNoReload = 'kept'; });
        for (const route of ['/app/docs', '/app/capture', '/app/chat', '/app'] as const) {
          await nav.locator(`a[data-tab="${route}"]`).click();
          await page.waitForURL((u) => u.pathname === route);
          await expectScreen(page, route as ScreenRoute, t);
          await expect(nav.locator(`a[data-tab="${route}"]`)).toHaveAttribute('aria-current', 'page');
          expect(await page.evaluate(() => (window as unknown as { __abNoReload?: string }).__abNoReload)).toBe('kept');
        }
      });
    }

    test('maya: badges match the live home data', async ({ page }) => {
      await loginAs(page, 'maya');
      await page.goto('/app');
      await settle(page);
      const t = catalogT((await pageLocales(page)).stringLocale);
      const home = await page.evaluate(async () => (await (await fetch('/api/v1/agentbook-core/mobile/home')).json()).data);
      const critical = (home.alerts as Array<{ severity: string }>).some((a) => a.severity === 'critical');
      const review = (home.alerts as Array<{ kind: string; params: { count?: number } }>).find((a) => a.kind === 'review_needed');
      const nav = tabNav(page, t);
      await expect(nav.locator('a[data-tab="/app"] [data-badge="home-dot"]')).toHaveCount(critical ? 1 : 0);
      if (review && Number(review.params.count) > 0) {
        await expect(nav.locator('a[data-tab="/app/docs"] [data-badge="docs-count"]')).toHaveText(String(review.params.count));
      } else {
        await expect(nav.locator('a[data-tab="/app/docs"] [data-badge="docs-count"]')).toHaveCount(0);
      }
    });

    test('every tab is a ≥44×44 target', async ({ page }) => {
      await loginAs(page, 'alex');
      await page.goto('/app');
      await settle(page);
      const t = catalogT((await pageLocales(page)).stringLocale);
      for (const href of ORDER) {
        const box = await tabNav(page, t).locator(`a[data-tab="${href}"]`).boundingBox();
        expect(box, href).not.toBeNull();
        expect(box!.width, `${href} width`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${href} height`).toBeGreaterThanOrEqual(44);
      }
    });

    test('a deep link renders inside the shell', async ({ page }) => {
      await loginAs(page, 'sydney');
      await page.goto('/app/chat');
      await settle(page);
      const t = catalogT((await pageLocales(page)).stringLocale);
      await expect(tabNav(page, t)).toBeVisible();
      await expectScreen(page, '/app/chat', t);
    });

    test('fresh account: the shell renders with no badges', async ({ page }) => {
      await loginAs(page, 'fresh');
      await page.goto('/app');
      await settle(page);
      const t = catalogT((await pageLocales(page)).stringLocale);
      await expect(tabNav(page, t).locator('a[data-tab]')).toHaveCount(4);
      await expect(page.locator('[data-badge]')).toHaveCount(0);
    });
  });

  test('safe-area insets (59px top / 34px bottom): every screen clears the tab bar and the page does not scroll', async ({ page, context, baseURL }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    // CDP safe-area emulation must be in place BEFORE the first navigation, or the
    // first layout runs with zero insets and measures the wrong thing.
    const emulated = await applySafeAreaInsets(context, page);
    test.skip(!emulated, 'this browser cannot emulate safe-area insets (Chromium CDP Emulation.setSafeAreaInsetsOverride)');

    if (loginUnavailableReason(baseURL) === null) {
      await loginAs(page, 'alex');
    } else {
      // Local dev server, no seeded personas: the middleware only checks that an auth
      // cookie is present, so a placeholder lets the shell mount. The screens' API calls
      // 401 — fine, this test measures the shell's geometry, not the data. Never sent
      // anywhere but the local dev host.
      expect(isLocalHost(baseURL), 'placeholder cookie is for a local dev server only').toBe(true);
      await context.addCookies([{ name: 'naap_auth_token', value: 'layout-check', url: baseURL! }]);
    }

    for (const route of ORDER) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.locator('#mobile-main').waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(1_500); // let the screen's own layout (and any skeleton → content swap) settle
      const g = await measureShell(page);

      // The insets really reached the layout: this is the guard on `env(safe-area-inset-*)` being used at all.
      expect(g.headerPaddingTop, `${route}: header honours the top inset`).toBe(`${IPHONE_INSETS.top}px`);
      expect(g.navPaddingBottom, `${route}: tab bar honours the bottom inset`).toBe(`${IPHONE_INSETS.bottom}px`);
      // Main reserves at least the tab bar's height (+ inset) so its last content can scroll clear of it.
      expect(parseFloat(g.mainPaddingBottom), `${route}: main reserves room for the tab bar`).toBeGreaterThanOrEqual(g.vh - g.navTop);
      // Content, scrolled to the end, sits above the tab bar's top edge.
      if (g.lastContentBottom !== null) {
        expect(g.lastContentBottom, `${route}: content clears the tab bar (nav top ${g.navTop})`).toBeLessThanOrEqual(g.navTop);
      }
      // The shell is one bounded viewport: only <main> scrolls.
      expect(g.docOverflow, `${route}: the document itself must not scroll`).toBeLessThanOrEqual(0);
    }

    // The chat composer — the control the legacy calc(100dvh - 64px) layout pushed 85px behind the bar.
    // Screen-agnostic: any text-entry control on /app/chat (PR 6 rewrites the screen; the contract stays).
    await page.goto('/app/chat', { waitUntil: 'domcontentloaded' });
    const composer = page.locator('#mobile-main').locator('textarea, input[type="text"], input:not([type]), [role="textbox"]').first();
    await expect(composer, 'chat has a text input').toBeVisible({ timeout: 60_000 });
    const [box, navBox] = [await composer.boundingBox(), await page.locator('[data-mobile-shell] nav').boundingBox()];
    expect(box, 'composer box').not.toBeNull();
    expect(navBox, 'tab bar box').not.toBeNull();
    expect(box!.y, 'composer top is inside the viewport').toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, 'composer is above the tab bar').toBeLessThanOrEqual(navBox!.y);
  });

  test('the manifest is still installable and the deployed sw.js carries the mobile rules', async ({ page }) => {
    const m = await (await page.request.get('/manifest.json')).json();
    expect(m.start_url).toBe('/app');
    expect(m.display).toBe('standalone');
    const sizes = (m.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    const sw = await (await page.request.get('/sw.js')).text();
    expect(sw).toContain("'/api/v1/agentbook-core/mobile/home'");
    expect(sw).toContain("'/api/v1/agentbook-core/calendar/upcoming'");
    expect(sw).toContain("agentbook-static-v6");
    expect(sw).toMatch(/data\?\.url \|\| '\/app'/);
  });
});
