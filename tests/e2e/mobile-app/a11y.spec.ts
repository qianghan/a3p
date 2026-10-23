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

async function open(page: Page, s: Screen, theme: 'light' | 'dark', errors: { console: string[] }) {
  await page.addInitScript((th) => {
    try { localStorage.setItem('theme', th); } catch { /* private mode */ }
  }, theme);
  await loginAs(page, 'maya');
  await settle(page);
  await page.goto('/app');
  // Let /app finish its requests BEFORE navigating away: navigating mid-request aborts the app's own fetches, which it
  // logs as 'Error fetching user/plugins: Failed to fetch' (that is the navigation, not a defect).
  await page.waitForLoadState('networkidle');
  errors.console.length = 0; // sign-in + first-page noise only; everything from here on stays strict
  await page.goto(await s.path(page));
  await expect(page.getByTestId(s.ready)).toBeVisible();
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);
  await proveLocale(page);
  await page.waitForLoadState('networkidle');
}

for (const theme of ['light', 'dark'] as const) {
  for (const s of SCREENS) {
    test(`axe: ${s.name} (${theme}) has zero serious/critical violations`, async ({ page, errors }, testInfo) => {
      await open(page, s, theme, errors);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      await testInfo.attach(`axe-${s.name}-${theme}.json`, { body: JSON.stringify(res.violations, null, 2), contentType: 'application/json' });
      expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
}

for (const s of SCREENS) {
  test(`targets: every interactive element on ${s.name} is at least 44x44`, async ({ page, errors }) => {
    await open(page, s, 'light', errors);
    const small = await page.evaluate(() => {
      const sel = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], input:not([type="hidden"]):not([type="file"]), select, textarea, summary';
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        // A checkbox/radio inside a <label> is tapped through the label (the whole row toggles it): measure that.
        const target = el.matches('input[type="checkbox"], input[type="radio"]') ? (el.closest('label') ?? el) : el;
        const r = target.getBoundingClientRect();
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

test('focus: the first 6 tab stops on Home show a visible focus ring', async ({ page, errors }) => {
  await open(page, SCREENS[0], 'light', errors);
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

/**
 * Playwright drops media emulation on every navigation (verified on a bare page: set before goto -> matchMedia false,
 * set after load -> true), so the preference is applied AFTER the page under test has loaded, and asserted to have
 * matched. Without that assertion this test passed or failed for reasons unrelated to motion.
 */
async function reduceMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced-motion emulation did not take effect').toBe(true);
}

const moving = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('*'))
    .filter((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.001;
    })
    .map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? '#' + el.dataset.testid : ''}${el.dataset.chatDot ? '[chat-dot]' : ''}.${String(el.className).slice(0, 40)} -> ${getComputedStyle(el).animationName}`));

test('reduced motion: nothing animates on the Home loading state', async ({ page, errors }) => {
  await page.route((u) => u.pathname === '/api/v1/agentbook-core/mobile/home', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    return route.continue();
  });
  await loginAs(page, 'maya');
  await settle(page);
  errors.console.length = 0; // sign-in noise only
  await page.goto('/app', { waitUntil: 'commit' });
  await expect(page.getByTestId(SEL.home.skeleton)).toBeVisible();
  await reduceMotion(page);
  expect(await moving(page)).toEqual([]);
});

test('reduced motion: nothing animates on the chat typing indicator', async ({ page, errors }) => {
  await page.route((u) => u.pathname === '/api/v1/agentbook-core/agent/message', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    return route.continue();
  });
  await loginAs(page, 'maya');
  await settle(page);
  await page.goto('/app/chat');
  await expect(page.getByTestId(SEL.chat.screen)).toBeVisible();
  await expect(page.getByTestId(SEL.chat.loading)).toHaveCount(0, { timeout: 30_000 });
  await proveLocale(page);
  errors.console.length = 0; // sign-in noise only
  await reduceMotion(page);
  await page.getByTestId(SEL.chat.input).fill('hello');
  await page.getByTestId(SEL.chat.send).click();
  await expect(page.getByTestId(SEL.chat.typing)).toBeVisible();
  expect(await moving(page)).toEqual([]);
});
