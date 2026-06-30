/**
 * Admin payroll-provider config, validated on the deployed app.
 * Net-clean: any change is restored to 'calculator'. Needs E2E_ADMIN_PW.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
const ADMIN_PW = process.env.E2E_ADMIN_PW || '';
const PATH = '/api/v1/admin/payroll-providers';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, { method: m, credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

test('payroll provider config requires auth', async ({ request }) => {
  expect((await request.get(PATH)).status()).toBe(401);
});

test('list + set + restore payroll provider config', async ({ page }) => {
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided');
  await page.goto('/login');
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await api(page, 'GET', PATH);
  expect(list.status, JSON.stringify(list.data)).toBe(200);
  expect(list.data.data.config.length).toBe(4);
  expect(list.data.data.providers.length).toBe(4);

  // Set CA → deel.
  expect((await api(page, 'PATCH', PATH, { jurisdiction: 'ca', provider: 'deel' })).status).toBe(200);
  const after = await api(page, 'GET', PATH);
  expect(after.data.data.config.find((c: { jurisdiction: string }) => c.jurisdiction === 'ca').provider).toBe('deel');

  // Restore CA → calculator (net-clean).
  expect((await api(page, 'PATCH', PATH, { jurisdiction: 'ca', provider: 'calculator' })).status).toBe(200);

  // Bad body → 400.
  expect((await api(page, 'PATCH', PATH, { jurisdiction: 'fr', provider: 'deel' })).status).toBe(400);
});
