/**
 * Referral program — code issuance + signup attribution, validated on the
 * deployed app. Uses Maya (seeded persona) as the referrer and a throwaway
 * invitee registered via the public signup flow with ?ref=<code>.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const MAYA_EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const MAYA_PW = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

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

test('unauthenticated /referrals/me requires auth', async ({ request }) => {
  const res = await request.get('/api/v1/agentbook-billing/referrals/me');
  expect(res.status()).toBe(401);
});

test('referral code issuance + signup attribution', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', MAYA_EMAIL);
  await page.fill('input[type="password"]', MAYA_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/agentbook|\/dashboard|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Maya's code is stable across calls (lazy-created once).
  const first = await api(page, 'GET', '/api/v1/agentbook-billing/referrals/me');
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  const code: string = first.data.data.code;
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(first.data.data.shareUrl).toContain(`ref=${code}`);
  expect(first.data.data.monthsCap).toBe(12);

  const second = await api(page, 'GET', '/api/v1/agentbook-billing/referrals/me');
  expect(second.data.data.code).toBe(code);

  const before = first.data.data.invitees.length;

  // Throwaway invitee, attributed via ?ref= on the register call.
  const inviteeEmail = `e2e-referral+${Date.now()}@example.com`;
  const reg = await api(page, 'POST', '/api/v1/auth/register', {
    email: inviteeEmail,
    password: 'Throwaway-123!',
    displayName: 'E2E Referral Invitee',
    ref: code,
  });
  expect([200, 201]).toContain(reg.status);

  // The invitee now shows up (masked) as "joined" for the referrer.
  let after;
  for (let i = 0; i < 5; i++) {
    after = await api(page, 'GET', '/api/v1/agentbook-billing/referrals/me');
    if (after.data.data.invitees.length > before) break;
    await page.waitForTimeout(1_000);
  }
  expect(after!.data.data.invitees.length).toBe(before + 1);
  const joined = after!.data.data.invitees[0];
  expect(joined.status).toBe('joined');
  expect(joined.maskedEmail).toMatch(/^e\*+@example\.com$/);
});

test('unknown referral code is ignored, not an error', async ({ page }) => {
  const inviteeEmail = `e2e-referral-noattr+${Date.now()}@example.com`;
  const res = await page.request.post('/api/v1/auth/register', {
    data: { email: inviteeEmail, password: 'Throwaway-123!', ref: 'ZZZZ-ZZZZ' },
  });
  expect([200, 201]).toContain(res.status());
});
