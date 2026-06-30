/**
 * Brand wordmark on the auth screens, validated on the deployed app.
 * The login/register screens now render the two-tone "agentbook" wordmark
 * instead of the old PNG, and the favicon SVG resolves.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('login renders the wordmark, not the old PNG logo', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('book', { exact: true })).toBeVisible();
  expect(await page.locator('img[src="/agentbook-logo.png"]').count()).toBe(0);
});

test('register renders the wordmark', async ({ page }) => {
  await page.goto('/register');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('img[src="/agentbook-logo.png"]').count()).toBe(0);
});

test('brand favicon svg resolves', async ({ request }) => {
  const res = await request.get('/icon.svg');
  expect(res.status()).toBe(200);
  expect((await res.text())).toContain('<svg');
});
