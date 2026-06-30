/**
 * Phase 2c e2e — cash vs accrual P&L on the deployed app.
 *
 * Logs in as Maya, then exercises the P&L report under both bases:
 *   - default (no param) returns accrual and matches ?basis=accrual exactly
 *     (no-regression guarantee for existing consumers)
 *   - ?basis=cash recognizes revenue from payments received, so it returns
 *     a valid, non-negative cash-revenue figure and reports basis: 'cash'
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}

test('P&L respects accounting basis and accrual is unchanged', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const base = '/api/v1/agentbook-tax/reports/pnl';

  const accrual = await apiGet(page, `${base}?basis=accrual`);
  expect(accrual.status).toBe(200);
  expect(accrual.data?.data?.basis).toBe('accrual');

  const def = await apiGet(page, base);
  expect(def.status).toBe(200);
  // Default basis matches accrual figures exactly (no-regression guarantee).
  expect(def.data.data.basis).toBe('accrual');
  expect(def.data.data.grossRevenueCents).toBe(accrual.data.data.grossRevenueCents);
  expect(def.data.data.netIncomeCents).toBe(accrual.data.data.netIncomeCents);

  const cash = await apiGet(page, `${base}?basis=cash`);
  expect(cash.status).toBe(200);
  expect(cash.data.data.basis).toBe('cash');
  // Cash revenue is derived from payments received — a valid non-negative number.
  expect(typeof cash.data.data.grossRevenueCents).toBe('number');
  expect(cash.data.data.grossRevenueCents).toBeGreaterThanOrEqual(0);
});
