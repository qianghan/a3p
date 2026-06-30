/**
 * Phase 2b e2e — deferred revenue on the deployed app.
 *
 * Logs in as Maya, creates a draft invoice that opts into a 12-month
 * deferral, then asserts the deferred-revenue endpoint reports the new
 * schedule (full amount unearned, period 12, nothing recognized yet).
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

test('deferred-revenue schedule is created for a retainer invoice', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Need a client to bill.
  const clients = await apiGet(page, '/api/v1/agentbook-invoice/clients?limit=1');
  expect(clients.status).toBe(200);
  const clientId = clients.data?.data?.[0]?.id;
  expect(clientId, 'Maya should have at least one client seeded').toBeTruthy();

  // Baseline deferred summary.
  const before = await apiGet(page, '/api/v1/agentbook-invoice/deferred-revenue');
  expect(before.status).toBe(200);
  const beforeUnearned = before.data?.summary?.unearnedCents ?? 0;

  // Create a retainer invoice deferred over 12 months ($6,000).
  const create = await apiPost(page, '/api/v1/agentbook-invoice/invoices', {
    clientId,
    status: 'draft',
    lines: [{ description: 'E2E retainer (deferred 12mo)', quantity: 1, rateCents: 6_000_00 }],
    deferOverMonths: 12,
  });
  expect(create.status).toBe(201);
  const invoiceId = create.data?.data?.id;
  expect(invoiceId).toBeTruthy();

  // The deferred schedule should now exist for this invoice.
  const after = await apiGet(page, '/api/v1/agentbook-invoice/deferred-revenue');
  expect(after.status).toBe(200);
  const row = (after.data?.data ?? []).find((r: any) => r.invoiceId === invoiceId);
  expect(row, 'deferred-revenue row for the new invoice').toBeTruthy();
  expect(row.totalAmountCents).toBe(6_000_00);
  expect(row.periodMonths).toBe(12);
  expect(row.recognizedAmountCents).toBe(0);
  expect(row.status).toBe('active');

  // Summary unearned should have grown by the full invoice amount.
  expect(after.data.summary.unearnedCents).toBe(beforeUnearned + 6_000_00);
});
