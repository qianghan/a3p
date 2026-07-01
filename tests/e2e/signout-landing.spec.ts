/**
 * Sign-out returns to the marketing landing page (/), not the sign-in form.
 * Asserts the landing via its <title> (reliable — the hero copy animates in).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

test('the landing page is the front door when signed out', async ({ page }) => {
  const resp = await page.goto('/');
  expect(resp?.status()).toBeLessThan(400); // not an error
  await expect(page).toHaveURL(`${BASE}/`); // not bounced to /login
  expect(await page.title()).toMatch(/Bookkeeping/i); // landing metadata
});

test('signing out lands on the landing page, not /login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/agentbook|\/dashboard|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Open the workspace switcher, then Sign out.
  await page.locator('button', { hasText: 'Personal' }).first().click();
  const signOut = page.getByText('Sign out', { exact: true });
  await signOut.waitFor({ state: 'visible', timeout: 8_000 });
  await signOut.click();

  await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
  expect(page.url()).not.toContain('/login');
  expect(await page.title()).toMatch(/Bookkeeping/i);
});
