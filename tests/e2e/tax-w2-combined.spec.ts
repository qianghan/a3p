/**
 * Phase 2a e2e — combined W-2 + self-employment tax estimate.
 *
 * Runs against whatever E2E_BASE_URL points at (production for the
 * post-deploy gate). Logs in as Maya, then drives the REST endpoints
 * through her authenticated cookie jar:
 *
 *   1. baseline: GET /tax/estimate succeeds (no regression from the new
 *      AbTaxConfig column reads)
 *   2. PUT /tax/config sets W-2 income + withholding
 *   3. GET /tax/estimate now reports combined_mode true, a credited
 *      amount_owed, and a total tax >= the business-only total
 *   4. cleanup: clear the W-2 fields again
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

// Run fetch inside the page so the session cookie is sent automatically.
async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}
async function apiPut(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

test('combined W-2 + SE estimate works on the deployed app', async ({ page }) => {
  // --- login ---
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  // Allow the session cookie / validation to settle before API calls.
  await page.waitForTimeout(2_000);

  // --- 1. baseline estimate (business only) ---
  const baseline = await apiGet(page, '/api/v1/agentbook-tax/tax/estimate');
  expect(baseline.status).toBe(200);
  expect(baseline.data?.success).toBe(true);
  const businessTotal = baseline.data.total_estimated_tax as number;
  expect(typeof businessTotal).toBe('number');
  expect(baseline.data.combined_mode).toBeFalsy();

  try {
    // --- 2. set W-2 income + withholding (cents) ---
    const putRes = await apiPut(page, '/api/v1/agentbook-tax/tax/config', {
      w2IncomeAnnual: 60_000_00,
      w2WithheldYtd: 9_000_00,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.data?.success).toBe(true);

    // --- 3. combined estimate ---
    const combined = await apiGet(page, '/api/v1/agentbook-tax/tax/estimate');
    expect(combined.status).toBe(200);
    expect(combined.data.combined_mode).toBe(true);
    expect(combined.data.w2_income).toBe(60_000);
    // W-2 wages stack on brackets → combined total tax >= business-only total
    expect(combined.data.total_estimated_tax).toBeGreaterThanOrEqual(businessTotal);
    // amount still owed = total − withholding, never negative
    expect(combined.data.amount_owed).toBeGreaterThanOrEqual(0);
    expect(combined.data.amount_owed).toBeCloseTo(
      Math.max(0, combined.data.total_estimated_tax - 9_000),
      1,
    );
  } finally {
    // --- 4. cleanup ---
    await apiPut(page, '/api/v1/agentbook-tax/tax/config', {
      w2IncomeAnnual: null,
      w2WithheldYtd: null,
    });
  }
});
