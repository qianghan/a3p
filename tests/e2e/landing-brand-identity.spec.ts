/**
 * Marketing landing page brand identity — teal accent + wordmark logo,
 * validated on the deployed app. The landing page previously used a
 * terracotta accent and plain-text "AgentBook" with no relation to the
 * product's actual teal two-tone wordmark used everywhere else.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('landing page renders the wordmark (nav + footer), not plain text', async ({ page }) => {
  await page.goto('/');
  const marks = page.locator('[aria-label="AgentBook"]');
  await expect(marks.first()).toBeVisible({ timeout: 15_000 });
  expect(await marks.count()).toBeGreaterThanOrEqual(2); // nav + footer
});

test('landing page accent color is the brand teal, not the old terracotta', async ({ page }) => {
  await page.goto('/');
  const accent = await page.evaluate(() => {
    const el = document.querySelector('.ab-landing') as HTMLElement | null;
    return el ? getComputedStyle(el).getPropertyValue('--accent').trim() : null;
  });
  expect(accent?.toLowerCase()).toBe('#149578');
  expect(accent?.toLowerCase()).not.toBe('#b04d2e');
});
