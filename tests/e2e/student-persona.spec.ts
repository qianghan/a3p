/**
 * Phase A validation — student businessType persona, on the deployed app.
 *
 * Registers a brand-new throwaway account (never touches Maya/Alex/Jordan's
 * seeded demo data — seeding student accounts upserts by (tenantId, code)
 * and would silently rename overlapping codes like 5100/5200 if run against
 * an existing freelancer-type tenant's books).
 *
 * Flow: register -> set businessType=student -> seed-jurisdiction -> assert
 * the student chart of accounts landed (tuition/scholarship/gig-income
 * categories), not the freelancer Schedule-C set.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';

test.use({ baseURL: BASE });

async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}
async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}
async function apiPut(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

test('student businessType seeds a student chart of accounts, not the freelancer one', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-student-${suffix}@agentbook.test`;
  const password = 'e2e-student-2026-x';

  // Navigate first so in-page fetch() has an origin to resolve relative URLs against.
  await page.goto('/login');

  // Register a fresh, isolated tenant.
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Student' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  // Log in via the UI so the httpOnly session cookie is set (matches the
  // documented prod e2e pattern — API calls must go through in-page fetch).
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const CORE = '/api/v1/agentbook-core';

  // Set the student persona.
  const cfg = await apiPut(page, `${CORE}/tenant-config`, { businessType: 'student' });
  expect(cfg.status, JSON.stringify(cfg.data)).toBe(200);

  // Seed the chart of accounts — this is the code path Phase A added
  // branching to (STUDENT_ACCOUNTS vs US_ACCOUNTS).
  const seed = await apiPost(page, `${CORE}/accounts/seed-jurisdiction`, {});
  expect(seed.status, JSON.stringify(seed.data)).toBe(200);

  const accounts = await apiGet(page, `${CORE}/accounts`);
  expect(accounts.status, JSON.stringify(accounts.data)).toBe(200);
  const names: string[] = accounts.data.data.map((a: { name: string }) => a.name);

  // Student-specific categories present...
  expect(names).toContain('Scholarship / Grant Income');
  expect(names).toContain('Tuition & Fees');
  expect(names).toContain('Tutoring / Gig Income');
  expect(names).toContain('Student Loan Interest');

  // ...and the freelancer Schedule-C categories that don't apply to a
  // student are absent (confirms the branch, not just an additive seed).
  expect(names).not.toContain('Commissions & Fees');
  expect(names).not.toContain('Contract Labor');
  expect(names).not.toContain('Legal & Professional');
});
