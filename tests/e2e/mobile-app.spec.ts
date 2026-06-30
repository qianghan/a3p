/**
 * Phase 6 e2e — mobile PWA shell on the deployed app.
 *
 * Asserts the manifest is served with start_url /app, then logs in as Maya
 * (mobile viewport), loads /app, and checks the bottom-nav tabs + a home tile
 * render, and that /app/docs and /app/chat load.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE, viewport: { width: 390, height: 844 } });

test('PWA manifest points at /app', async ({ page }) => {
  const res = await page.request.get('/manifest.json');
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.start_url).toBe('/app');
  expect(manifest.name).toBe('AgentBook');
});

test('mobile /app shell renders with bottom nav and tabs', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  await page.goto('/app');
  // Bottom nav tabs present.
  for (const label of ['Home', 'Capture', 'Docs', 'Chat']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  // A home tile label renders.
  await expect(page.getByText('Revenue', { exact: true })).toBeVisible();

  // Docs tab loads.
  await page.goto('/app/docs');
  await expect(page.getByText('Documents', { exact: true })).toBeVisible();

  // Chat tab loads with a composer.
  await page.goto('/app/chat');
  await expect(page.getByPlaceholder('Type a message…')).toBeVisible();
});
