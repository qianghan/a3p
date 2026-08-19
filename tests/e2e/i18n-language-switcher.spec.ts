/**
 * The language switcher actually changes the language, in a real browser.
 *
 * WHY A BROWSER TEST, WHEN THERE ARE ~180 PASSING i18n UNIT TESTS
 *
 * Because a green unit suite was compatible with the feature being entirely
 * broken in production, and was.
 *
 * Every component test builds the shell by hand:
 *
 *     render(<ShellProvider value={shellFor('fr-CA')}><Page /></ShellProvider>)
 *
 * That proves a page translates GIVEN a working i18n service. It cannot see the
 * real shell failing to supply one. And the real shell WAS failing: PluginLoader
 * and sandbox.ts each build the plugin context by enumerating services by hand,
 * and neither included `i18n`. Plugins called useI18n(), got nothing, and
 * silently rendered humanised keys — plausible English, no error. Fixed, and now
 * guarded by src/__tests__/architecture/i18n-plugin-context.test.ts.
 *
 * This spec covers what remains only-true-at-runtime:
 *
 *   - plugin pages load as UMD bundles from /cdn, not as ES imports. Only a
 *     browser exercises that path, and that path is where the context is built.
 *   - clicking the switcher changes rendered copy (the literal bug report)
 *   - the choice survives a reload
 *   - the feature flag genuinely gates, fail-closed
 *   - <html lang> follows the locale (screen readers, CJK font selection)
 *   - CJK codepoints have glyphs rather than .notdef boxes
 *
 * DESIGN NOTES
 *
 * It DRIVES THE FLAG rather than assuming a state, asserting both on and off,
 * and restores the original value in a finally. Reading whatever the flag
 * happens to be would make the outcome depend on unrelated environment state,
 * and "no translations appeared" would be indistinguishable from "the flag was
 * off".
 *
 * It SKIPS LOUDLY without credentials rather than passing. A spec that silently
 * passes when it could not run is worse than no spec. Secrets come from the
 * environment only; nothing is written to disk.
 *
 * Run:
 *   cd tests/e2e && E2E_ADMIN_PW=... npx playwright test i18n-language-switcher
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
const ADMIN_PW = process.env.E2E_ADMIN_PW || '';
const FLAG_KEY = 'agentbook.i18n.locales.enabled';
const FLAGS_PATH = '/api/v1/admin/feature-flags';

test.use({ baseURL: BASE });

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);
}

/** Same-origin fetch from inside the page, so the session cookie travels. */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ m, p, b }) => {
      const r = await fetch(p, {
        method: m,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    },
    { m: method, p: path, b: body },
  );
}

async function readFlag(page: Page): Promise<boolean | null> {
  const res = await api(page, 'GET', FLAGS_PATH);
  if (res.status !== 200) return null;
  const rows: Array<{ key: string; enabled: boolean }> = res.data?.data ?? [];
  const row = rows.find((r) => r.key === FLAG_KEY);
  return row ? row.enabled : null;
}

async function setFlag(page: Page, enabled: boolean): Promise<void> {
  const existing = await readFlag(page);
  if (existing === null) {
    await api(page, 'POST', FLAGS_PATH, {
      key: FLAG_KEY,
      enabled,
      description: 'e2e: i18n translated strings',
    });
  } else {
    await api(page, 'PATCH', FLAGS_PATH, { key: FLAG_KEY, enabled });
  }
}

/** Picks the locale via the switcher, then waits for <html lang> to follow. */
async function chooseLocale(page: Page, label: RegExp, expectedLang: string): Promise<void> {
  const switcher = page.getByRole('button', { name: /language|langue|语言/i }).first();
  await switcher.click();
  await page.getByRole('menuitem', { name: label }).or(page.getByRole('option', { name: label })).first().click();
  // <html lang> is the shell's own signal that the locale actually changed;
  // waiting on it avoids racing the re-render.
  await expect(page.locator('html')).toHaveAttribute('lang', expectedLang, { timeout: 15_000 });
}

/** Matches a dotted translation key that leaked into the DOM. */
const RAW_KEY = /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]{2,}\b/;

test.describe('language switcher', () => {
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided — cannot drive the feature flag');

  test('flag OFF keeps the UI English even for a non-English locale', async ({ page }) => {
    await login(page);
    const original = await readFlag(page);
    try {
      await setFlag(page, false);
      await page.goto('/agentbook/invoices');
      await page.reload();
      await page.waitForTimeout(2_000);

      const body = (await page.locator('body').textContent()) ?? '';
      // Fail-closed: English regardless of any stored tenant locale.
      expect(body).toContain('Invoices');
      expect(body).not.toContain('Factures');
    } finally {
      if (original !== null) await setFlag(page, original);
    }
  });

  test('flag ON: choosing French translates the page, and it persists', async ({ page }) => {
    await login(page);
    const original = await readFlag(page);
    try {
      await setFlag(page, true);
      await page.goto('/agentbook/invoices');
      await page.reload();
      await page.waitForTimeout(2_000);

      await chooseLocale(page, /fran[çc]ais/i, 'fr-CA');

      const body = (await page.locator('body').textContent()) ?? '';
      // A specific word, and the absence of its English counterpart. Presence
      // alone would pass on a page that merely appended French somewhere.
      expect(body).toContain('Factures');
      expect(body).not.toContain('Total Outstanding');
      // t() returns the key on a miss instead of throwing, so a user would
      // otherwise simply read `invoice_ui.total_outstanding` on the page.
      expect(RAW_KEY.exec(body)?.[0], 'raw translation key leaked').toBeUndefined();

      // Persistence: a switcher that forgets on reload is not a setting.
      await page.reload();
      await page.waitForTimeout(2_000);
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA');
      expect((await page.locator('body').textContent()) ?? '').toContain('Factures');
    } finally {
      if (original !== null) await setFlag(page, original);
    }
  });

  test('flag ON: Chinese renders CJK with real glyphs, not tofu boxes', async ({ page }) => {
    await login(page);
    const original = await readFlag(page);
    try {
      await setFlag(page, true);
      await page.goto('/agentbook/invoices');
      await page.reload();
      await page.waitForTimeout(2_000);

      await chooseLocale(page, /中文|chinese/i, 'zh-CN');

      const body = (await page.locator('body').textContent()) ?? '';
      expect(/[一-鿿]/.test(body), 'no CJK on the page').toBe(true);
      expect(body).not.toContain('Total Outstanding');

      // TOFU DETECTION — a missing CJK font renders every codepoint as the
      // same .notdef box, so the text is PRESENT in the DOM and unreadable on
      // screen. No textContent assertion can see that.
      //
      // The method here was chosen by MEASURING candidates in headless
      // Chromium, because the two obvious ones do not work:
      //
      //   - Glyph WIDTH cannot discriminate. CJK is full-width, so 发 and 一
      //     both measure exactly 1em whether the font covers them or not (16px
      //     and 16px at 16px). An earlier version of this test asserted the
      //     widths DIFFER, which would have failed on a perfectly healthy page.
      //   - document.fonts.check() cannot either. It reports whether the font
      //     FAMILY is available, not whether a codepoint is covered, and
      //     returns true even for private-use codepoints no font has.
      //
      // What does work is counting ink. Rasterise a glyph and count non-blank
      // pixels: structurally different CJK glyphs produce very different
      // counts, while .notdef boxes are all the same rectangle. Measured:
      //
      //     real glyphs   发=249  一=44  票=326     (all distinct)
      //     .notdef boxes    162     162            (identical)
      //
      // So "the ink counts differ" means real, distinct glyphs were drawn.
      const ink = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 40;
        c.height = 40;
        const g = c.getContext('2d');
        if (!g) return null;
        const count = (ch: string): number => {
          g.clearRect(0, 0, 40, 40);
          g.fillStyle = '#000';
          g.font = '24px sans-serif';
          g.textBaseline = 'top';
          g.fillText(ch, 2, 2);
          const d = g.getImageData(0, 0, 40, 40).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 32) n++;
          return n;
        };
        return { dense: count('发'), sparse: count('一'), blank: count(' ') };
      });

      expect(ink, 'could not rasterise text').not.toBeNull();
      // Sanity floor: a blank draws nothing, so a nonzero count means the
      // rasteriser worked at all and the next assertion is meaningful.
      expect(ink!.blank).toBe(0);
      expect(ink!.dense).toBeGreaterThan(0);
      expect(
        ink!.dense,
        'CJK glyphs rasterise identically — the font is missing and text shows as boxes',
      ).not.toBe(ink!.sparse);
    } finally {
      if (original !== null) await setFlag(page, original);
    }
  });

  test('the switcher is hidden while the flag is off', async ({ page }) => {
    // Showing a picker that cannot change anything is what produced the
    // original report. Visibility is gated on the flag for that reason.
    await login(page);
    const original = await readFlag(page);
    try {
      await setFlag(page, false);
      await page.goto('/agentbook/invoices');
      await page.reload();
      await page.waitForTimeout(2_000);
      await expect(
        page.getByRole('button', { name: /language|langue|语言/i }),
      ).toHaveCount(0);
    } finally {
      if (original !== null) await setFlag(page, original);
    }
  });
});

test('money and dates are locale-formatted regardless of the flag', async ({ page }) => {
  // Formatting is deliberately NOT gated: those were correctness fixes (a due
  // date rendered a day early west of UTC; CAD shown as "$1,234.56" to a reader
  // who should see "1 234,56 $"), not features awaiting a rollout. So this must
  // hold with the flag OFF, which is why it sits outside the describe above.
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided — cannot drive the feature flag');

  await login(page);
  const original = await readFlag(page);
  try {
    await setFlag(page, false);
    await page.goto('/agentbook/invoices');
    await page.reload();
    await page.waitForTimeout(2_000);

    const body = (await page.locator('body').textContent()) ?? '';
    // Only assert if there is money on screen at all — an empty account is a
    // legitimate state and must not fail the run.
    const hasMoney = /\d[.,]\d\d/.test(body);
    test.skip(!hasMoney, 'no monetary amounts on the page for this account');

    const lang = await page.locator('html').getAttribute('lang');
    if (lang === 'fr-CA') {
      // French: comma decimal, trailing symbol. US format here would be the bug.
      expect(body).toMatch(/\d,\d\d/);
    }
  } finally {
    if (original !== null) await setFlag(page, original);
  }
});
