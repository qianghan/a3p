import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('Past Tax Filings UI', () => {
  test.beforeEach(async ({ page }) => {
    // Log in as Maya
    await page.goto(`${BASE}/login`);
    await page.fill('[name=email]', 'maya@agentbook.test');
    await page.fill('[name=password]', 'agentbook123');
    await page.click('[type=submit]');
    await page.waitForURL(/dashboard|tax|agentbook/);
    await page.goto(`${BASE}/agentbook/tax-package`);
  });

  test('Past Filings tab is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Past Filings' })).toBeVisible();
  });

  test('clicking Past Filings tab shows upload dropzone', async ({ page }) => {
    await page.getByRole('button', { name: 'Past Filings' }).click();
    await expect(page.getByText('Drag & drop PDF here')).toBeVisible();
  });

  test('year and jurisdiction pickers are present', async ({ page }) => {
    await page.getByRole('button', { name: 'Past Filings' }).click();
    await expect(page.locator('select').first()).toBeVisible();
  });

  test('Year-end Package tab still works', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Year-end Package' })).toBeVisible();
    await page.getByRole('button', { name: 'Year-end Package' }).click();
    await expect(page.getByText('Generate package')).toBeVisible();
  });
});
