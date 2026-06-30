/**
 * Admin user actions, validated on the deployed app.
 *
 * Exercises the new PATCH /api/v1/admin/users/[id] against a throwaway user
 * registered via the public signup flow, then suspends/reactivates and
 * grants/revokes admin — ending the throwaway active + non-admin (net clean).
 * Also checks the lockout guard (can't suspend yourself) + 400/404.
 *
 * Needs an admin login: E2E_ADMIN_EMAIL / E2E_ADMIN_PW.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
const ADMIN_PW = process.env.E2E_ADMIN_PW || '';

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

test('admin user actions require auth', async ({ request }) => {
  const res = await request.patch('/api/v1/admin/users/nope', { data: { action: 'suspend' } });
  expect(res.status()).toBe(401);
});

test('suspend / reactivate / grant / revoke + guards', async ({ page }) => {
  test.skip(!ADMIN_PW, 'E2E_ADMIN_PW not provided');

  await page.goto('/login');
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Create a throwaway target via public signup.
  const targetEmail = `e2e-target+${Date.now()}@example.com`;
  const reg = await api(page, 'POST', '/api/v1/auth/register', {
    email: targetEmail,
    password: 'Throwaway-123!',
    displayName: 'E2E Target',
  });
  expect([200, 201]).toContain(reg.status);

  // Find the target's id from the admin list.
  const findTarget = async () => {
    const list = await api(page, 'GET', '/api/v1/admin/users');
    expect(list.status, JSON.stringify(list.data)).toBe(200);
    return list.data.data.users.find((u: { email: string }) => u.email === targetEmail);
  };
  let target = await findTarget();
  expect(target, 'throwaway user present in admin list').toBeTruthy();
  expect(target.suspended).toBeFalsy();

  // Suspend → reactivate.
  expect((await api(page, 'PATCH', `/api/v1/admin/users/${target.id}`, { action: 'suspend' })).status).toBe(200);
  target = await findTarget();
  expect(target.suspended).toBe(true);
  expect((await api(page, 'PATCH', `/api/v1/admin/users/${target.id}`, { action: 'reactivate' })).status).toBe(200);
  target = await findTarget();
  expect(target.suspended).toBeFalsy();

  // Grant → revoke admin.
  expect((await api(page, 'PATCH', `/api/v1/admin/users/${target.id}`, { action: 'grantAdmin' })).status).toBe(200);
  target = await findTarget();
  expect(target.roles).toContain('system:admin');
  expect((await api(page, 'PATCH', `/api/v1/admin/users/${target.id}`, { action: 'revokeAdmin' })).status).toBe(200);
  target = await findTarget();
  expect(target.roles).not.toContain('system:admin');

  // Validation + lockout guard.
  expect((await api(page, 'PATCH', `/api/v1/admin/users/${target.id}`, { action: 'delete' })).status).toBe(400);
  expect((await api(page, 'PATCH', '/api/v1/admin/users/does-not-exist', { action: 'suspend' })).status).toBe(404);

  const me = await api(page, 'GET', '/api/v1/auth/me');
  const myId = me.data?.data?.id || me.data?.user?.id || me.data?.id;
  if (myId) {
    expect((await api(page, 'PATCH', `/api/v1/admin/users/${myId}`, { action: 'suspend' })).status).toBe(400);
  }
});
