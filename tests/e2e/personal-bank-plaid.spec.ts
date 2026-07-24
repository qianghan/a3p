/**
 * E2E for the personal-finance Plaid integration. Following
 * bank-plaid.spec.ts's established precedent (the expense-side
 * equivalent): the true Plaid OAuth round-trip is not automated (Link's
 * UI is iframed) — sync/sign-flip logic is covered by
 * agentbook-personal-plaid.test.ts's vitest cases instead. This spec
 * verifies the deployed endpoints' shape and gate enforcement against a
 * real logged-in session, mirroring bank-backfill-complete.spec.ts's
 * pattern for the expense side.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

const API = '/api/v1/agentbook-personal';

async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

async function registerAndLogin(page: import('@playwright/test').Page, prefix: string): Promise<string> {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `${prefix}-${suffix}@agentbook.test`;
  const password = 'e2e-personal-bank-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Personal Bank' }),
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

  return email;
}

test.describe('Personal finance bank sync (Plaid) — gate + shape', () => {
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });

  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('POST /plaid/link-token returns 402 for a tenant without personal_insights', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbank-no-addon');
    const result = await apiPost(page, `${API}/plaid/link-token`, {});
    expect(result.status).toBe(402);
  });

  test('POST /plaid/link-token returns a linkToken for an entitled tenant', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-personalbank-entitled');
    const user = await prisma.user.findUnique({ where: { email } });
    const tenantId = user!.id;

    const addOn = await prisma.billAddOn.upsert({
      where: { code: 'personal_insights' },
      update: { isActive: true },
      create: { code: 'personal_insights', name: 'Personal Insights', interval: 'month', isActive: true },
    });
    const price = await prisma.billAddOnPrice.upsert({
      where: { addOnId_region_tier: { addOnId: addOn.id, region: 'us', tier: 'standard' } },
      update: { isActive: true },
      create: { addOnId: addOn.id, region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, isActive: true },
    });
    await prisma.billAddOnSubscription.upsert({
      where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
      create: { accountId: tenantId, addOnId: addOn.id, priceId: price.id, status: 'active' },
      update: { status: 'active', priceId: price.id, canceledAt: null },
    });

    const result = await apiPost(page, `${API}/plaid/link-token`, {});
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(typeof result.data.data.linkToken).toBe('string');
  });

  test('POST /plaid/disconnect works without the add-on (never gated)', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbank-disconnect');
    // No account with this id exists for this tenant — disconnectAccount
    // no-ops on a missing row, so this just proves the route itself
    // isn't gated (a 402 here would mean the gate leaked onto this route).
    const result = await apiPost(page, `${API}/plaid/disconnect`, { accountId: 'nonexistent' });
    expect(result.status).toBe(200);
  });
});
