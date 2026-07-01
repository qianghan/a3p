/**
 * Tax section-wide tab bar, validated on the deployed app. Previously only
 * the Tax Dashboard was a discoverable entry point — following the "Upload
 * prior-year returns" link into Tax Package (or any other tax subpage) was a
 * dead end with no way back. Every tax page now shares one persistent tab
 * bar (Dashboard / Quarterly / Deductions / Cash Flow / Analytics / What If /
 * Reports / Tax Package).
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

test('Tax Package shows the tab bar and can navigate back to Dashboard', async ({ page }) => {
  await login(page);
  await page.goto('/agentbook/tax-package');
  await page.waitForTimeout(3_000);

  // The fix: from Tax Package, every other tax page (including Dashboard) is
  // one click away.
  for (const label of ['Dashboard', 'Quarterly', 'Deductions', 'Cash Flow', 'Analytics', 'What If', 'Reports', 'Tax Package']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible({ timeout: 10_000 });
  }

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.waitForURL(/\/agentbook\/tax$/, { timeout: 10_000 });
  await expect(page.getByText('Total Estimated Tax')).toBeVisible({ timeout: 10_000 });
});

test('the tab bar is present and highlights the active tab on a secondary page', async ({ page }) => {
  await login(page);
  await page.goto('/agentbook/cashflow');
  await page.waitForTimeout(3_000);
  const cashFlowTab = page.getByRole('link', { name: 'Cash Flow', exact: true });
  await expect(cashFlowTab).toBeVisible({ timeout: 10_000 });
  await expect(cashFlowTab).toHaveClass(/text-primary/);
});
