import { test, expect } from './fixtures';
import { MOBILE_VIEWPORT, loginAs, settle, pageLocales } from './helpers';
import { SEL } from './selectors';
import { forceLocale, catalogValues, commonValue } from './locale';

// strictErrors:false ignores ONLY the browser's own "Failed to load resource" lines: the unauthenticated /login page
// load issues 401 probes before sign-in. Uncaught errors and every other console.error still fail the test.
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block', strictErrors: false });

const SCREENS = [
  { name: 'home', path: '/app', ready: SEL.home.screen, prefix: 'mobile.home.' },
  { name: 'docs', path: '/app/docs', ready: SEL.docs.screen, prefix: 'mobile.docs.' },
  { name: 'capture', path: '/app/capture', ready: SEL.capture.screen, prefix: 'mobile.capture.' },
  { name: 'chat', path: '/app/chat', ready: SEL.chat.screen, prefix: 'mobile.chat.' },
] as const;
const SCREEN_NS = new Set(['home', 'docs', 'viewer', 'capture', 'chat']);
const usable = (v: string) => !v.includes('{') && v.trim().length >= 2;

for (const locale of ['fr-CA', 'zh-CN'] as const) {
  test.describe(`${locale} in a real browser`, () => {
    for (const s of SCREENS) {
      test(`${s.name} renders translated copy and no English mobile strings`, async ({ page }, testInfo) => {
        await forceLocale(page, locale);
        await loginAs(page, 'maya');
        await settle(page);
        await page.goto(s.path);
        await expect(page.getByTestId(s.ready)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${locale.split('-')[0]}`));
        await page.waitForTimeout(1500); // the locale pack is a lazy chunk; let it land

        const en = catalogValues('en');
        const loc = catalogValues(locale);

        // Anti-vacuity: the page really renders THIS locale's strings (the app's own flag state says so,
        // and a locale-specific heading/tab label from the catalog is on screen), so the English-left
        // check below cannot pass merely because we compared against the wrong catalog.
        expect((await pageLocales(page)).stringLocale, 'page string locale').toBe(locale);
        if (s.name === 'home') {
          await expect(page.getByTestId(SEL.shell.tabHome), 'catalog locale does not match the rendered page').toContainText(loc['mobile.tabs.home']);
        } else if (s.name === 'docs') {
          await expect(page.getByRole('heading', { level: 1 }), 'catalog locale does not match the rendered page').toHaveText(commonValue(locale, 'documents'));
        } else {
          await expect(page.getByRole('heading', { level: 1 }), 'catalog locale does not match the rendered page').toHaveText(loc[`mobile.${s.name}.title`]);
        }

        const body = await page.locator('body').innerText();
        const screenKeys = Object.keys(loc).filter((k) => k.startsWith(s.prefix) && usable(loc[k]));
        const shellKeys = Object.keys(loc).filter((k) => !SCREEN_NS.has(k.split('.')[1]) && usable(loc[k]));
        const shownScreen = screenKeys.filter((k) => body.includes(loc[k]));
        const shownShell = shellKeys.filter((k) => body.includes(loc[k]));
        const englishLeft = [...screenKeys, ...shellKeys].filter(
          (k) => en[k] && en[k] !== loc[k] && en[k].length >= 8 && !en[k].includes('{') && body.includes(en[k]),
        );

        await testInfo.attach(`${s.name}-${locale}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
        expect(shownScreen.length, `${locale} ${s.name}: translated screen strings visible`).toBeGreaterThanOrEqual(2);
        expect(shownShell.length, `${locale} ${s.name}: translated tab/shell strings visible`).toBeGreaterThanOrEqual(3);
        expect(englishLeft, `${locale} ${s.name}: English mobile strings still visible`).toEqual([]);
      });
    }
  });
}
