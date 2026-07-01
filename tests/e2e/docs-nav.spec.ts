/**
 * Docs navigation — the side nav (sections) and a "Back to the app" link are
 * present across the docs site, including the docs home.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('docs home shows the side nav + Back to the app', async ({ page }) => {
  await page.goto('/docs');
  // Side nav sections are visible on the home (desktop).
  await expect(page.getByRole('link', { name: /Configure/ }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /Troubleshooting/ }).first()).toBeVisible();
  // Back to the app link points at the app.
  const back = page.getByRole('link', { name: /Back to the app/i }).first();
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', '/agentbook');
});

test('a guide page also has the side nav + back link', async ({ page }) => {
  await page.goto('/docs/setup/quickstart');
  await expect(page.getByRole('link', { name: /Back to the app/i }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /Configure/ }).first()).toBeVisible();
});
