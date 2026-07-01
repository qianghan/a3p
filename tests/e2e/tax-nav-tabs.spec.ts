/**
 * Tax nav — Dashboard + Tax Package tabs, validated on the deployed app.
 * Previously the tab bar's hrefs were wrongly prefixed with an extra "/tax"
 * segment (/agentbook/tax/tax-package instead of /agentbook/tax-package),
 * which didn't match any route in the plugin's own router — so the URL
 * changed but the rendered content silently fell back to Dashboard every
 * time ("nothing changes" on click). These tests assert on rendered content
 * unique to each page, not just link visibility/URL, so this class of bug
 * can't slip through again.
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

test('nav shows exactly Dashboard + Tax Package (simplified, no other tabs)', async ({ page }) => {
  await login(page);
  await page.goto('/agentbook/tax');
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: 'Tax Package', exact: true })).toBeVisible();
  for (const stale of ['Quarterly', 'Deductions', 'Cash Flow', 'Analytics', 'What If', 'Reports']) {
    await expect(page.getByRole('link', { name: stale, exact: true })).toHaveCount(0);
  }
});

test('Dashboard -> Tax Package actually renders Tax Package content', async ({ page }) => {
  await login(page);
  await page.goto('/agentbook/tax');
  await page.waitForTimeout(3_000);
  await expect(page.getByText('Total Estimated Tax')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: 'Tax Package', exact: true }).click();
  await page.waitForURL(/\/agentbook\/tax-package$/, { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  // Content unique to Tax Package — proves the plugin router actually
  // matched the route, not just that the URL bar changed.
  await expect(page.getByRole('button', { name: 'Year-end Package' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Total Estimated Tax')).toHaveCount(0);
});

test('Tax Package -> Dashboard actually renders Dashboard content', async ({ page }) => {
  await login(page);
  await page.goto('/agentbook/tax-package');
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('button', { name: 'Year-end Package' })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.waitForURL(/\/agentbook\/tax$/, { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByText('Total Estimated Tax')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Year-end Package' })).toHaveCount(0);
});
