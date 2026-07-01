/**
 * Referral program UI — dashboard invite banner + Settings > Referrals tab,
 * validated on the deployed app.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const MAYA_EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const MAYA_PW = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', MAYA_EMAIL);
  await page.fill('input[type="password"]', MAYA_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/agentbook|\/dashboard|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);
}

test('invite banner shows on the dashboard, links to Referrals, and dismiss persists', async ({ page }) => {
  await login(page);
  await page.evaluate(() => window.localStorage.removeItem('ab_referral_banner_dismissed'));
  await page.goto('/agentbook');
  await page.waitForTimeout(1_000);

  const banner = page.getByText('Invite a friend', { exact: false });
  await expect(banner).toBeVisible({ timeout: 10_000 });

  // It should NOT appear on an unrelated page (non-invasive — targeted, not global).
  await page.goto('/settings');
  await page.waitForTimeout(1_000);
  await expect(page.getByText('Invite a friend', { exact: false })).toHaveCount(0);

  // Back on the dashboard, dismiss it — then confirm it's gone even after reload.
  await page.goto('/agentbook');
  await page.waitForTimeout(1_000);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Invite a friend', { exact: false })).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1_000);
  await expect(page.getByText('Invite a friend', { exact: false })).toHaveCount(0);

  // Clean up localStorage state for repeatability of this test.
  await page.evaluate(() => window.localStorage.removeItem('ab_referral_banner_dismissed'));
});

test('Referrals tab is reachable via deep-link and renders the code + progress', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=agentbook&subtab=referrals');
  await page.waitForTimeout(2_000);

  await expect(page.getByText('Invite friends, earn free months')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Your referral code')).toBeVisible();
  await expect(page.getByText('Your share link')).toBeVisible();
  await expect(page.getByText(/\d+ \/ 12 months earned/)).toBeVisible();
});
