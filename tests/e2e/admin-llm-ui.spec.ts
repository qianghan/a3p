/**
 * Admin LLM providers UI, validated on the deployed app. Read-only — does not
 * mutate the live LLM config (no create/delete/set-default in prod). Verifies
 * the existing API is reachable for admins and the Config page renders the
 * LLM Providers section. Needs E2E_ADMIN_PW.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
const ADMIN_PW = process.env.E2E_ADMIN_PW || '';
const API = '/api/v1/agentbook-core/admin/llm-configs';

test.use({ baseURL: BASE });

test('llm-configs API requires auth', async ({ request }) => {
  expect((await request.get(API)).status()).toBe(401);
});

test('admin can list LLM providers and the Config page shows the section', async ({ page }) => {
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided');
  await page.goto('/login');
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, API);
  expect(list.status, JSON.stringify(list.data)).toBe(200);
  expect(Array.isArray(list.data.data)).toBe(true);

  await page.goto('/admin/config');
  await expect(page.getByText('LLM Providers').first()).toBeVisible({ timeout: 15_000 });
});
