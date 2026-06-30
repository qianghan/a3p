/**
 * Bank backfill completeness signal, validated on the deployed app.
 *
 * The manual Plaid sync now returns a `complete` flag so an onboarding
 * "import my history" flow can re-POST until the first-time historical
 * backfill is fully drained. This asserts the deployed contract.
 *
 * Note: the seeded Maya account has no connected Plaid item in prod, so this
 * exercises the endpoint shape + the vacuous "complete" case, not a real
 * multi-page drain (which needs an interactive Plaid Link connection).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

test('plaid sync returns a complete flag and consistent counts', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000); // session cookie needs ~2s to settle

  const res = await page.evaluate(async () => {
    const r = await fetch('/api/v1/agentbook-expense/plaid/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  });

  expect(res.status, JSON.stringify(res.data)).toBe(200);
  expect(res.data.success).toBe(true);
  const d = res.data.data;
  expect(typeof d.complete).toBe('boolean');
  expect(typeof d.accountsSynced).toBe('number');
  expect(typeof d.transactionsImported).toBe('number');
  expect(d.transactionsImported).toBeGreaterThanOrEqual(0);
  // With no connected accounts there is nothing left to drain → complete.
  if (d.accountsSynced === 0) {
    expect(d.complete).toBe(true);
    expect(d.transactionsImported).toBe(0);
  }
});
