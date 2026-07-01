/**
 * UX consistency / a11y — global focus-visible ring, reduced-motion, and
 * brand ::selection are applied app-wide. Verifies the rules shipped by scanning
 * the deployed CSSOM, and that a key page still renders (no regression).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('global a11y/consistency rules are present in the deployed CSS', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').waitFor({ timeout: 15_000 });

  const found = await page.evaluate(() => {
    let focusRing = false, reducedMotion = false, selection = false;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { continue; } // skip cross-origin
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const t = (rule as CSSRule).cssText || '';
        if (t.includes(':focus-visible') && t.includes('outline')) focusRing = true;
        if (t.includes('prefers-reduced-motion')) reducedMotion = true;
        if (t.includes('::selection') || t.includes('::-moz-selection')) selection = true;
      }
    }
    return { focusRing, reducedMotion, selection };
  });

  expect(found.reducedMotion, 'prefers-reduced-motion rule shipped').toBe(true);
  expect(found.focusRing, ':focus-visible outline rule shipped').toBe(true);
  expect(found.selection, '::selection rule shipped').toBe(true);
});

test('login still renders (no regression from global CSS)', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});
