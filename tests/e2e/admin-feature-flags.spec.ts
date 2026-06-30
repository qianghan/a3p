/**
 * Admin feature flags, validated on the deployed app. Net-clean: the test flag
 * it creates is deleted at the end. Needs E2E_ADMIN_PW.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
const ADMIN_PW = process.env.E2E_ADMIN_PW || '';
const PATH = '/api/v1/admin/feature-flags';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, { method: m, credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

test('feature flags require auth', async ({ request }) => {
  expect((await request.get(PATH)).status()).toBe(401);
});

test('feature flags: create, toggle, delete', async ({ page }) => {
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided');
  await page.goto('/login');
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const key = `e2e.flag-${Date.now()}`;

  expect((await api(page, 'GET', PATH)).status).toBe(200);

  // Create (disabled).
  const created = await api(page, 'POST', PATH, { key, enabled: false, description: 'e2e test flag' });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  expect(created.data.data.enabled).toBe(false);

  // Toggle on.
  const toggled = await api(page, 'PATCH', PATH, { key, enabled: true });
  expect(toggled.status).toBe(200);
  expect(toggled.data.data.enabled).toBe(true);

  // Present + on in the list.
  const list = await api(page, 'GET', PATH);
  const found = list.data.data.flags.find((f: { key: string }) => f.key === key);
  expect(found?.enabled).toBe(true);

  // Validation: unknown toggle → 404; bad body → 400.
  expect((await api(page, 'PATCH', PATH, { key: 'nope.nope.nope', enabled: true })).status).toBe(404);
  expect((await api(page, 'POST', PATH, { key: 'bad key', enabled: true })).status).toBe(400);

  // Cleanup.
  const del = await api(page, 'DELETE', `${PATH}?key=${encodeURIComponent(key)}`);
  expect(del.status).toBe(200);
});
