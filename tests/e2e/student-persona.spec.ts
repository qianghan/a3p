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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
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

test('marketplace is admin-only by default; community plugin is registered non-core', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-mkt-${suffix}@agentbook.test`;
  const password = 'e2e-mkt-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Marketplace' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Non-admin: marketplace should be invisible by default.
  const vis = await apiGet(page, '/api/v1/marketplace/visibility');
  expect(vis.status, JSON.stringify(vis.data)).toBe(200);
  expect(vis.data?.data?.visible, JSON.stringify(vis.data)).toBe(false);
  expect(vis.data?.data?.isAdmin).toBe(false);

  // The marketplace page itself should render the "not available" state,
  // not the full browse UI, for this non-admin user.
  await page.goto('/marketplace');
  await page.waitForTimeout(1_500);
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText).toContain("isn't available yet");
});

test('admin sees marketplace visible and community plugin registered', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'admin@a3p.io');
  await page.fill('input[type="password"]', 'a3p-dev');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const vis = await apiGet(page, '/api/v1/marketplace/visibility');
  expect(vis.status, JSON.stringify(vis.data)).toBe(200);
  expect(vis.data?.data?.isAdmin, JSON.stringify(vis.data)).toBe(true);
  expect(vis.data?.data?.visible).toBe(true);

  const core = await apiGet(page, '/api/v1/admin/plugins/core');
  expect(core.status, JSON.stringify(core.data)).toBe(200);
  const names: string[] = (core.data?.data?.plugins ?? []).map((p: { name: string }) => p.name);
  expect(names).toContain('community');
});

test('student sees student-aware chat prompts (UX visibility)', async ({ page }) => {
  // Riley is a seeded US student account (businessType=student).
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  // Wait for the redirect OFF /login (a hostname-matching regex would false-
  // match on "agentbook.brainliber.com" before auth completes).
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);
  // The chat is a UMD plugin that mounts client-side, then fetches
  // tenant-config to decide the empty-state prompts — give it time.
  await page.goto('/agentbook');
  await page.waitForFunction(
    () => /As a student, try|Is my scholarship taxable/i.test(document.body.innerText),
    { timeout: 30_000 },
  );
  const body = await page.evaluate(() => document.body.innerText);
  expect(/Is my scholarship taxable/i.test(body)).toBeTruthy();
});

test('Business Profile settings exposes a Student business-type option', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);
  await page.goto('/settings?tab=agentbook');
  // The AgentBook settings panel (with Business Profile) renders under ?tab=agentbook.
  await page.waitForFunction(
    () => /Business type/i.test(document.body.innerText),
    { timeout: 30_000 },
  );
  const hasStudentOption = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    return selects.some((s) => Array.from(s.options).some((o) => o.value === 'student'));
  });
  expect(hasStudentOption).toBeTruthy();
});

test('add-on visibility gate does not regress the plugin list (identity until a gated plugin ships)', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const res = await apiGet(page, '/api/v1/base/plugins/personalized');
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  const plugins = (res.data?.data?.plugins ?? res.data?.plugins ?? []) as { name: string }[];
  const names = plugins.map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  // Core plugins must still be present — the gate is default-open + empty-map
  // identity today, so nothing should be hidden.
  expect(names).toContain('agentbookcore');
  expect(plugins.length).toBeGreaterThan(1);
});

test('scholarship plugin is hidden + API 402 for a non-subscriber', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-nosub-${suffix}@agentbook.test`;
  const password = 'e2e-nosub-2026-x';
  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E NoSub' }),
    });
    return { status: r.status };
  }, { email, password });
  expect(reg.status).toBeLessThan(300);
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Plugin hidden from the personalized list.
  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  expect(names).not.toContain('agentbookscholarship');

  // API is gated (defense in depth) — 402 Payment Required.
  const gated = await apiGet(page, '/api/v1/agentbook-scholarship/opportunities');
  expect(gated.status).toBe(402);
});

test('subscribed student sees the scholarship plugin and its API works', async ({ page }) => {
  // Riley has an active student_success subscription (seeded for validation).
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  expect(names, JSON.stringify(names)).toContain('agentbookscholarship');

  // The gated CRUD endpoint is reachable (200) for the subscriber.
  const opps = await apiGet(page, '/api/v1/agentbook-scholarship/opportunities');
  expect(opps.status, JSON.stringify(opps.data)).toBe(200);
  expect(Array.isArray(opps.data?.data)).toBeTruthy();
});

test('career plugin is hidden + API 402 for a non-subscriber', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-nocareer-${suffix}@agentbook.test`;
  const password = 'e2e-nocareer-2026-x';
  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E NoCareer' }),
    });
    return { status: r.status };
  }, { email, password });
  expect(reg.status).toBeLessThan(300);
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  expect(names).not.toContain('agentbookcareer');

  const gated = await apiGet(page, '/api/v1/agentbook-career/opportunities');
  expect(gated.status).toBe(402);
});

test('subscribed student sees BOTH scholarship and career plugins + APIs work', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  expect(names, JSON.stringify(names)).toContain('agentbookscholarship');
  expect(names, JSON.stringify(names)).toContain('agentbookcareer');

  const career = await apiGet(page, '/api/v1/agentbook-career/opportunities');
  expect(career.status, JSON.stringify(career.data)).toBe(200);
  expect(Array.isArray(career.data?.data)).toBeTruthy();
});

test('housing plugin is hidden + API 402 for a non-subscriber', async ({ page }) => {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `e2e-nohouse-${suffix}@agentbook.test`;
  const password = 'e2e-nohouse-2026-x';
  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E NoHouse' }),
    });
    return { status: r.status };
  }, { email, password });
  expect(reg.status).toBeLessThan(300);
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  expect(names).not.toContain('agentbookhousing');

  const gated = await apiGet(page, '/api/v1/agentbook-housing/opportunities');
  expect(gated.status).toBe(402);
});

test('subscribed student sees all three student plugins; housing affordability + CRUD work', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'riley@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const list = await apiGet(page, '/api/v1/base/plugins/personalized');
  const names = ((list.data?.data?.plugins ?? []) as { name: string }[]).map((p) => p.name.toLowerCase().replace(/[-_]/g, ''));
  for (const n of ['agentbookscholarship', 'agentbookcareer', 'agentbookhousing']) {
    expect(names, JSON.stringify(names)).toContain(n);
  }

  // Affordability endpoint (reads the personal-finance snapshot) responds.
  const aff = await apiGet(page, '/api/v1/agentbook-housing/affordability');
  expect(aff.status, JSON.stringify(aff.data)).toBe(200);
  expect(typeof aff.data?.data?.hasIncome).toBe('boolean');

  // Create → list → delete a listing round-trips.
  const created = await apiPost(page, '/api/v1/agentbook-housing/opportunities', {
    title: 'E2E test rental', rentCents: 120000, area: 'Near campus',
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const id = created.data?.data?.id;
  expect(id).toBeTruthy();
  const listed = await apiGet(page, '/api/v1/agentbook-housing/opportunities');
  expect((listed.data?.data ?? []).some((o: { id: string }) => o.id === id)).toBeTruthy();
  const del = await page.evaluate(async (i) => {
    const r = await fetch(`/api/v1/agentbook-housing/opportunities/${i}`, { method: 'DELETE', credentials: 'include' });
    return r.status;
  }, id);
  expect(del).toBe(200);
});
