/**
 * Phase 2d e2e — accounts-payable bills on the deployed app.
 *
 * Logs in as Maya, creates a bill, confirms it appears as open, pays it,
 * confirms it flips to paid, and checks the AP aging report responds with
 * the expected bucket shape.
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

test('AP bill lifecycle: create → open → pay → aging', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Create a bill due in 14 days.
  const due = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const create = await apiPost(page, '/api/v1/agentbook-expense/bills', {
    vendorName: 'E2E Vendor',
    description: 'E2E test bill',
    amountCents: 250_00,
    dueDate: due,
  });
  expect(create.status).toBe(201);
  const billId = create.data?.data?.id;
  expect(billId).toBeTruthy();

  // It should show up among open bills.
  const open = await apiGet(page, '/api/v1/agentbook-expense/bills?status=open');
  expect(open.status).toBe(200);
  expect((open.data.data ?? []).some((b: any) => b.id === billId)).toBe(true);
  expect(open.data.summary.openCents).toBeGreaterThanOrEqual(250_00);

  // Pay it.
  const pay = await apiPost(page, `/api/v1/agentbook-expense/bills/${billId}?action=pay`, {});
  expect(pay.status).toBe(200);
  expect(pay.data.data.status).toBe('paid');

  // Now it should be in the paid list, not the open list.
  const paid = await apiGet(page, '/api/v1/agentbook-expense/bills?status=paid');
  expect((paid.data.data ?? []).some((b: any) => b.id === billId)).toBe(true);

  // AP aging report responds with the four buckets.
  const aging = await apiGet(page, '/api/v1/agentbook-tax/reports/ap-aging');
  expect(aging.status).toBe(200);
  expect(aging.data.data.buckets).toHaveProperty('current');
  expect(aging.data.data.buckets).toHaveProperty('d1_30');
  expect(aging.data.data.buckets).toHaveProperty('d31_60');
  expect(aging.data.data.buckets).toHaveProperty('d60_plus');
});
