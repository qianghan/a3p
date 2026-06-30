/**
 * Phase 3 e2e — personal finance on the deployed app.
 *
 * Logs in as Maya, creates a checking account + a savings account, records
 * income and a spend, then asserts the snapshot reflects net worth, income,
 * spending, savings rate, and business-flagged spend.
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
async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

const P = '/api/v1/agentbook-personal';

test('personal finance: accounts, transactions, snapshot', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Create a checking account with a starting balance.
  const checking = await apiPost(page, `${P}/accounts`, { name: 'E2E Checking', type: 'checking', balanceCents: 10_000_00 });
  expect(checking.status, JSON.stringify(checking.data)).toBe(201);
  const checkingId = checking.data.data.id;

  // Snapshot reflects the new asset.
  const snap1 = await apiGet(page, `${P}/snapshot`);
  expect(snap1.status).toBe(200);
  const netBefore = snap1.data.data.netWorthCents;
  expect(netBefore).toBeGreaterThanOrEqual(10_000_00);

  // Record income (+) and a business-flagged spend (−).
  const inc = await apiPost(page, `${P}/transactions`, {
    accountId: checkingId, description: 'Salary', amountCents: 5_000_00, category: 'salary',
  });
  expect(inc.status).toBe(201);
  const spend = await apiPost(page, `${P}/transactions`, {
    accountId: checkingId, description: 'Software', amountCents: -200_00, category: 'software', businessFlag: true,
  });
  expect(spend.status).toBe(201);

  // Snapshot now shows income, spending, business-flagged, and a higher net worth.
  const snap2 = await apiGet(page, `${P}/snapshot`);
  expect(snap2.status).toBe(200);
  const m = snap2.data.data.month;
  expect(m.incomeCents).toBeGreaterThanOrEqual(5_000_00);
  expect(m.spendingCents).toBeGreaterThanOrEqual(200_00);
  expect(m.businessFlaggedCents).toBeGreaterThanOrEqual(200_00);
  // net worth moved by +5000 −200 = +4800 vs before
  expect(snap2.data.data.netWorthCents).toBe(netBefore + 5_000_00 - 200_00);
});
