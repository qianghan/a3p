/**
 * Admin Skills API, validated on the deployed app.
 *
 * Auth is admin-session OR the CRON_SECRET via x-admin-secret (mirrors
 * seed-skills), so this verifies the deployed endpoint server-side without a
 * browser login. Pass the secret as E2E_ADMIN_SECRET (never commit it).
 *
 * The toggle test captures a skill's current state, flips it, verifies, then
 * restores it — net-zero change to production.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const SECRET = process.env.E2E_ADMIN_SECRET || '';
const PATH = '/api/v1/admin/skills';

test.use({ baseURL: BASE });

test('admin skills API requires auth', async ({ request }) => {
  const res = await request.get(PATH); // no secret, no session
  expect(res.status()).toBe(401);
});

test('admin skills: list + toggle via admin session, and the page renders', async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL || 'qiang.han@gmail.com';
  const pw = process.env.E2E_ADMIN_PW || '';
  test.skip(!pw, 'E2E_ADMIN_PW not provided');

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/admin|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // API via the authenticated session cookie.
  const list = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, PATH);
  expect(list.status, JSON.stringify(list.data)).toBe(200);
  expect(Array.isArray(list.data.data.skills)).toBe(true);
  expect(list.data.data.skills.length).toBeGreaterThan(0);

  const skill = list.data.data.skills[0];
  const original: boolean = skill.enabled;

  const flip = await page.evaluate(async ({ p, body }) => {
    const r = await fetch(p, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: PATH, body: { name: skill.name, enabled: !original } });
  expect(flip.status, JSON.stringify(flip.data)).toBe(200);
  expect(flip.data.data.enabled).toBe(!original);

  // Restore (no regression).
  const restore = await page.evaluate(async ({ p, body }) => {
    const r = await fetch(p, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status };
  }, { p: PATH, body: { name: skill.name, enabled: original } });
  expect(restore.status).toBe(200);

  // The admin Skills page renders for an admin.
  await page.goto('/admin/skills');
  await expect(page.getByText('Agent Skills').first()).toBeVisible({ timeout: 15_000 });
});

test('admin skills: list + toggle (with restore)', async ({ request }) => {
  test.skip(!SECRET, 'E2E_ADMIN_SECRET not provided');
  const hdr = { 'x-admin-secret': SECRET };

  const listRes = await request.get(PATH, { headers: hdr });
  expect(listRes.status()).toBe(200);
  const list = await listRes.json();
  expect(list.success).toBe(true);
  expect(Array.isArray(list.data.skills)).toBe(true);
  expect(list.data.skills.length).toBeGreaterThan(0);
  const skill = list.data.skills[0];
  expect(typeof skill.name).toBe('string');
  expect(typeof skill.enabled).toBe('boolean');

  const original = skill.enabled;

  // Flip it.
  const flip = await request.patch(PATH, { headers: hdr, data: { name: skill.name, enabled: !original } });
  expect(flip.status()).toBe(200);
  expect((await flip.json()).data.enabled).toBe(!original);

  // GET reflects the flip.
  const after = await request.get(PATH, { headers: hdr });
  const flipped = (await after.json()).data.skills.find((s: { name: string }) => s.name === skill.name);
  expect(flipped.enabled).toBe(!original);

  // Restore original state (no regression).
  const restore = await request.patch(PATH, { headers: hdr, data: { name: skill.name, enabled: original } });
  expect(restore.status()).toBe(200);
  expect((await restore.json()).data.enabled).toBe(original);

  // Unknown skill → 404; bad body → 400.
  expect((await request.patch(PATH, { headers: hdr, data: { name: '__nope__', enabled: true } })).status()).toBe(404);
  expect((await request.patch(PATH, { headers: hdr, data: { name: 123 } })).status()).toBe(400);
});
