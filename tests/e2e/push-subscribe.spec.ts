/**
 * Follow-on F3 e2e — Web Push subscription storage on the deployed app.
 *
 * Logs in as Maya, POSTs a fake PushSubscription to /api/v1/push/subscribe,
 * and confirms it is stored on the tenant config (then clears it).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

test('push subscription is stored and cleared', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const fakeSub = { endpoint: 'https://example.com/push/e2e', keys: { p256dh: 'abc', auth: 'def' } };

  // Reject a malformed subscription.
  const bad = await api(page, 'POST', '/api/v1/push/subscribe', { subscription: { not: 'valid' } });
  expect(bad.status).toBe(400);

  // Store a valid subscription.
  const ok = await api(page, 'POST', '/api/v1/push/subscribe', { subscription: fakeSub });
  expect(ok.status).toBe(200);
  expect(ok.data.success).toBe(true);

  // It is persisted on the tenant config.
  const cfg = await api(page, 'GET', '/api/v1/agentbook-core/tenant-config');
  expect(cfg.status).toBe(200);
  expect(cfg.data.data.pushSubscription?.endpoint).toBe(fakeSub.endpoint);

  // Clean up.
  const del = await api(page, 'DELETE', '/api/v1/push/subscribe');
  expect(del.status).toBe(200);
});
