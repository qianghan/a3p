/**
 * CPA invite email wiring, validated on the deployed app.
 *
 * Creating an invite now attempts a (best-effort) email and reports `emailSent`.
 * The invite + manual link must succeed regardless of delivery, so this asserts
 * the route returns 201 with a url and a boolean emailSent — not delivery
 * itself, which depends on a verified Resend sending domain.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, {
      method: m,
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

test('CPA invite creates the invite + reports emailSent (delivery best-effort)', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const created = await api(page, 'POST', '/api/v1/agentbook-cpa/invite', {
    cpaEmail: `e2e-cpa+${Date.now()}@example.com`,
    cpaName: 'E2E Accountant',
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  expect(created.data.data.url).toContain('/cpa-portal/');
  expect(typeof created.data.data.emailSent).toBe('boolean'); // wiring present; delivery may be false until domain verified

  // Invalid email is still rejected.
  const bad = await api(page, 'POST', '/api/v1/agentbook-cpa/invite', { cpaEmail: 'not-an-email' });
  expect(bad.status).toBe(400);
});
