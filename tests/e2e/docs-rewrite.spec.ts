/**
 * Docs rewrite — the NaaP developer docs are replaced by the AgentBook user
 * help center (Set up / Configure / Working / Troubleshooting). Public pages.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('docs home is the AgentBook help center, not NaaP', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Set up', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Working day-to-day').first()).toBeVisible();
  expect(await page.getByText('NaaP', { exact: false }).count()).toBe(0);
});

test('a user guide renders', async ({ page }) => {
  await page.goto('/docs/setup/quickstart');
  await expect(page.getByText('Get started in five minutes').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.getByText('NaaP', { exact: false }).count()).toBe(0);
});

test('old NaaP dev-doc URLs redirect to the help center (no 500)', async ({ page }) => {
  const resp = await page.goto('/docs/concepts/what-is-naap');
  expect(resp?.status()).toBeLessThan(400); // followed the redirect; never 500
  expect(page.url()).toContain('/docs');
  await expect(page.getByText('Set up', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  expect(await page.getByText('NaaP', { exact: false }).count()).toBe(0);
});
