/**
 * E2E for the personal-finance Basiq integration (AU personal-finance
 * bank-sync). Following personal-bank-plaid.spec.ts's established
 * precedent (the Plaid equivalent): the true Basiq Consent UI round-trip
 * is not automated (it's a hosted, redirected third-party flow — no
 * client-embeddable widget like Plaid Link) and requires a real
 * `BASIQ_API_KEY`, which is not available in this environment (see
 * `agentbook/PRODUCTION-ENV.md`'s "Basiq env vars" section — obtaining one
 * requires the account owner to sign up with Basiq directly). Sync/sign
 * logic is covered by `agentbook-personal-basiq-sync.ts`'s own unit
 * tests instead.
 *
 * This spec verifies the deployed endpoints' shape and — the part that
 * genuinely doesn't require a live Basiq key — that the same
 * `requirePersonalInsightsAddon` gate Plaid's personal routes sit behind
 * fires correctly for Basiq's personal routes too, mirroring
 * `personal-bank-plaid.spec.ts`'s pattern exactly.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

const API = '/api/v1/agentbook-personal';

async function apiFetch(
  page: import('@playwright/test').Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  return page.evaluate(
    async ({ m, p, b }) => {
      const r = await fetch(p, {
        method: m,
        headers: b !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: b !== undefined ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    },
    { m: method, p: path, b: body },
  );
}

async function registerAndLogin(page: import('@playwright/test').Page, prefix: string): Promise<string> {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `${prefix}-${suffix}@agentbook.test`;
  const password = 'e2e-personal-basiq-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // NOTE: `ageConfirmed: true` is required by the real /register route
      // (apps/web-next/src/app/api/v1/auth/register/route.ts) — this was
      // added after personal-bank-plaid.spec.ts was originally written, so
      // that older sibling spec is currently stale/broken against a live
      // deploy for the same reason. Not fixed here since that file is out
      // of scope for this change; flagged separately.
      body: JSON.stringify({ email, password, displayName: 'E2E Personal Basiq', ageConfirmed: true }),
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

async function grantPersonalInsights(
  prisma: typeof import('@naap/database').prisma,
  tenantId: string,
): Promise<void> {
  const addOn = await prisma.billAddOn.upsert({
    where: { code: 'personal_insights' },
    update: { isActive: true },
    create: { code: 'personal_insights', name: 'Personal Insights', interval: 'year', isActive: true },
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
}

test.describe('Personal finance bank sync (Basiq/AU) — gate + shape', () => {
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });

  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('POST /bank/basiq/consent-url returns 402 for a tenant without personal_insights', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbasiq-no-addon-cu');
    const result = await apiFetch(page, 'POST', `${API}/bank/basiq/consent-url`, {});
    expect(result.status).toBe(402);
  });

  test('GET /bank/basiq/status returns 402 for a tenant without personal_insights', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbasiq-no-addon-st');
    const result = await apiFetch(page, 'GET', `${API}/bank/basiq/status?jobId=nonexistent`);
    expect(result.status).toBe(402);
  });

  test('POST /bank/basiq/sync returns 402 for a tenant without personal_insights', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbasiq-no-addon-sy');
    const result = await apiFetch(page, 'POST', `${API}/bank/basiq/sync`, {});
    expect(result.status).toBe(402);
  });

  test('POST /bank/basiq/consent-url passes the gate for an entitled tenant', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-personalbasiq-entitled');
    const user = await prisma.user.findUnique({ where: { email } });
    const tenantId = user!.id;
    await grantPersonalInsights(prisma, tenantId);

    const result = await apiFetch(page, 'POST', `${API}/bank/basiq/consent-url`, {});
    // The gate itself (requirePersonalInsightsAddon) must not 402 an
    // entitled tenant. We deliberately do NOT assert a 200 here: without a
    // real BASIQ_API_KEY configured in this environment (see
    // agentbook/PRODUCTION-ENV.md), the route's downstream
    // createBasiqUser()/getBasiqClientToken() calls to Basiq's real API
    // will fail and the route falls through to its own caught 500 — that
    // is the correct, documented behavior until BASIQ_API_KEY is
    // provisioned, not a bug in the gate this test verifies.
    expect(result.status).not.toBe(402);
  });

  test('POST /bank/basiq/disconnect works without the add-on (never gated)', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbasiq-disconnect');
    // No account with this id exists for this tenant — disconnect no-ops
    // on a missing row, so this just proves the route itself isn't gated
    // (a 402 here would mean the gate leaked onto this route), mirroring
    // agentbook-personal/plaid/disconnect's exact precedent.
    const result = await apiFetch(page, 'POST', `${API}/bank/basiq/disconnect`, { accountId: 'nonexistent' });
    expect(result.status).toBe(200);
  });
});
