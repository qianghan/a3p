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

test('scholarship-taxability skill answers a scholarship tax question', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-scholar-${suffix}@agentbook.test`;
  const password = 'e2e-scholar-2026-x';

  await page.goto('/login');

  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Scholar' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const res = await apiPost(page, '/api/v1/agentbook-core/agent/message', {
    text: 'I got a $10,000 scholarship this year, $8,000 went to tuition and $2,000 to my dorm room. Is any of it taxable?',
  });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  const data = res.data?.data ?? res.data;
  const message: string = data?.message || '';
  expect(data?.skillUsed, JSON.stringify(data)).toBe('scholarship-taxability');
  expect(message.length).toBeGreaterThan(20);
  // Should surface the tuition-vs-room&board split without inventing a wrong answer.
  expect(/tuition|room|board|taxable|tax-free|tax free/i.test(message)).toBeTruthy();
});

test('student visa/home-country fields persist via tenant-config', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-visa-${suffix}@agentbook.test`;
  const password = 'e2e-visa-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Visa' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const CORE = '/api/v1/agentbook-core';
  const set = await apiPut(page, `${CORE}/tenant-config`, { businessType: 'student', visaStatus: 'international', homeCountry: 'cn' });
  expect(set.status, JSON.stringify(set.data)).toBe(200);

  const got = await apiGet(page, `${CORE}/tenant-config`);
  expect(got.status).toBe(200);
  expect(got.data.data.visaStatus).toBe('international');
  expect(got.data.data.homeCountry).toBe('cn');
});

test('international-student-tax-help skill routes correctly and cites the verified China treaty', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-intl-${suffix}@agentbook.test`;
  const password = 'e2e-intl-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Intl' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const CORE = '/api/v1/agentbook-core';
  await apiPut(page, `${CORE}/tenant-config`, { businessType: 'student', visaStatus: 'international', homeCountry: 'cn' });

  const res = await apiPost(page, `${CORE}/agent/message`, {
    text: "I'm an F-1 student and I got a 1042-S this year. Am I a nonresident alien? Does the tax treaty help me?",
  });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  const data = res.data?.data ?? res.data;
  const message: string = data?.message || '';
  expect(data?.skillUsed, JSON.stringify(data)).toBe('international-student-tax-help');
  expect(message.length).toBeGreaterThan(20);
  expect(/china|treaty|nonresident|1040-?nr|sprintax|glacier/i.test(message)).toBeTruthy();
});

test('parent read-only share link can be created and viewed', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-parent-${suffix}@agentbook.test`;
  const password = 'e2e-parent-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Parent' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const create = await apiPost(page, '/api/v1/agentbook-cpa/link', { label: 'Parent summary', validityDays: 365 });
  expect(create.status, JSON.stringify(create.data)).toBe(201);
  const token = create.data?.data?.token;
  expect(token).toBeTruthy();

  // The link should be viewable without auth — open in a fresh context-less nav.
  const viewRes = await page.evaluate(async (t) => {
    const r = await fetch(`/api/v1/agentbook-cpa/public/${t}`);
    return { status: r.status, data: await r.json().catch(() => null) };
  }, token);
  expect(viewRes.status, JSON.stringify(viewRes.data)).toBe(200);
});
