import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { MOBILE_VIEWPORT, catalogT, loginAs, pageLocales, settle } from './helpers';
import { SEL } from './selectors';
import { inPageFetch } from './page-api';

/**
 * Spec 8.3 accessibility on all four screens + the viewer, light AND dark, on a DEPLOYED site.
 * Maya's tenant renders in her stored locale (fr-CA when the i18n flag is on), so no UI string is hardcoded:
 * every label comes from the app's own catalog and the locale is PROVEN before anything is measured.
 * Zero serious/critical axe violations is the bar; no rule is disabled and nothing is excluded.
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block' });

type Screen = { name: string; path: (p: Page) => Promise<string>; ready: string };
const SCREENS: Screen[] = [
  { name: 'home', path: async () => '/app', ready: SEL.home.screen },
  { name: 'docs', path: async () => '/app/docs', ready: SEL.docs.screen },
  {
    name: 'viewer',
    path: async (p) => {
      const r = await inPageFetch<{ data: Array<{ id: string }> }>(p, 'GET', '/api/v1/agentbook-expense/expenses?limit=1');
      const id = r.data?.data?.[0]?.id;
      expect(id, 'Maya has at least one expense to open in the viewer').toBeTruthy();
      return `/app/docs/${id}`;
    },
    ready: SEL.viewer.screen,
  },
  { name: 'capture', path: async () => '/app/capture', ready: SEL.capture.screen },
  { name: 'chat', path: async () => '/app/chat', ready: SEL.chat.screen },
];

/** Prove the catalog `t` matches what is rendered (the shell tab label), so string checks cannot pass vacuously. */
async function proveLocale(page: Page) {
  const { stringLocale } = await pageLocales(page);
  const t = catalogT(stringLocale);
  await expect(page.getByTestId(SEL.shell.tabHome), 'catalog locale does not match the rendered page').toContainText(t('mobile.tabs.home'));
  return t;
}

async function open(page: Page, s: Screen, theme: 'light' | 'dark') {
  await page.addInitScript((th) => {
    try { localStorage.setItem('theme', th); } catch { /* private mode */ }
  }, theme);
  await loginAs(page, 'maya');
  await settle(page);
  await page.goto('/app');
  await page.goto(await s.path(page));
  await expect(page.getByTestId(s.ready)).toBeVisible();
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);
  await proveLocale(page);
  await page.waitForLoadState('networkidle');
}

for (const theme of ['light', 'dark'] as const) {
  for (const s of SCREENS) {
    test(`axe: ${s.name} (${theme}) has zero serious/critical violations`, async ({ page }, testInfo) => {
      await open(page, s, theme);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      await testInfo.attach(`axe-${s.name}-${theme}.json`, { body: JSON.stringify(res.violations, null, 2), contentType: 'application/json' });
      expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
}

for (const s of SCREENS) {
  test(`targets: every interactive element on ${s.name} is at least 44x44`, async ({ page }) => {
    await open(page, s, 'light');
    const small = await page.evaluate(() => {
      const sel = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], input:not([type="hidden"]):not([type="file"]), select, textarea, summary';
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (el.tagName === 'A' && el.closest('p, li')) continue; // WCAG 2.5.8 inline-link exception
        if (r.width < 44 || r.height < 44) {
          const label = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 30);
          out.push(`${el.tagName.toLowerCase()}[${label}] ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    });
    expect(small).toEqual([]);
  });
}

test('focus: the first 6 tab stops on Home show a visible focus ring', async ({ page }) => {
  await open(page, SCREENS[0], 'light');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return 'none-focused';
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? 'ok' : `${el.tagName}:${el.getAttribute('data-testid') ?? ''}`;
    });
    expect(ring).toBe('ok');
  }
});

test('reduced motion: nothing animates on Home skeleton or the chat typing indicator', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route((u) => u.pathname === '/api/v1/agentbook-core/mobile/home', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });
  await page.route((u) => u.pathname === '/api/v1/agentbook-core/agent/message', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });
  await loginAs(page, 'maya');
  await settle(page);
  const moving = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const cs = getComputedStyle(el);
        return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.001;
      })
      .map((el) => el.getAttribute('data-testid') || el.tagName));
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.skeleton)).toBeVisible();
  expect(await moving()).toEqual([]);
  await page.goto('/app/chat');
  await expect(page.getByTestId(SEL.chat.loading)).toHaveCount(0, { timeout: 30_000 });
  await proveLocale(page);
  await page.getByTestId(SEL.chat.input).fill('hello');
  await page.getByTestId(SEL.chat.send).click();
  await expect(page.getByTestId(SEL.chat.typing)).toBeVisible();
  expect(await moving()).toEqual([]);
});
