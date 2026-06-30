/**
 * F6 — accounting polish, validated on the deployed app.
 *
 * F6.1 Balance sheet: under accrual, an open (unpaid) bill is recognized as an
 *      Accounts Payable line with an offsetting reduction in retained earnings,
 *      so the sheet stays balanced. Under cash basis it is not.
 * F6.2 Tax estimate honors the accounting basis with a ?basis= override and
 *      echoes the basis it used.
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

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000); // session cookie needs ~2s to settle
}

test('F6.1 balance sheet: open bill becomes A/P under accrual, sheet stays balanced', async ({ page }) => {
  await login(page);

  const BILL_CENTS = 4_242_00;
  const bill = await apiPost(page, '/api/v1/agentbook-expense/bills', {
    vendorName: `E2E F6 Vendor ${Date.now()}`,
    amountCents: BILL_CENTS,
    dueDate: '2026-12-31',
  });
  expect(bill.status, JSON.stringify(bill.data)).toBeLessThan(300);

  // Accrual: the open bill is recognized as A/P; the sheet remains balanced.
  const accrual = await apiGet(page, '/api/v1/agentbook-tax/reports/balance-sheet?basis=accrual');
  expect(accrual.status, JSON.stringify(accrual.data)).toBe(200);
  expect(accrual.data.data.accountingBasis).toBe('accrual');
  expect(accrual.data.data.balanced).toBe(true);
  expect(accrual.data.data.accountsPayableOpenCents).toBeGreaterThanOrEqual(BILL_CENTS);
  const apLine = accrual.data.data.liabilities.find(
    (l: { accountId: string }) => l.accountId === 'derived:accounts-payable',
  );
  expect(apLine, 'A/P line present under accrual').toBeTruthy();
  expect(apLine.balanceCents).toBeGreaterThanOrEqual(BILL_CENTS);

  // Cash: open bills are not on the cash books; no A/P line; still balanced.
  const cash = await apiGet(page, '/api/v1/agentbook-tax/reports/balance-sheet?basis=cash');
  expect(cash.status, JSON.stringify(cash.data)).toBe(200);
  expect(cash.data.data.accountingBasis).toBe('cash');
  expect(cash.data.data.balanced).toBe(true);
  expect(cash.data.data.accountsPayableOpenCents).toBe(0);
});

test('F6.2 tax estimate: honors ?basis= and echoes the basis used', async ({ page }) => {
  await login(page);

  const accrual = await apiGet(page, '/api/v1/agentbook-tax/tax/estimate?basis=accrual');
  expect(accrual.status, JSON.stringify(accrual.data)).toBe(200);
  expect(accrual.data.data.accountingBasis).toBe('accrual');
  expect(typeof accrual.data.data.totalTaxCents).toBe('number');
  expect(accrual.data.data.totalTaxCents).toBeGreaterThanOrEqual(0);

  const cash = await apiGet(page, '/api/v1/agentbook-tax/tax/estimate?basis=cash');
  expect(cash.status, JSON.stringify(cash.data)).toBe(200);
  expect(cash.data.data.accountingBasis).toBe('cash');
  expect(typeof cash.data.data.totalTaxCents).toBe('number');
  expect(cash.data.data.totalTaxCents).toBeGreaterThanOrEqual(0);

  // Cash revenue (payments received) never exceeds accrual revenue (invoiced):
  // unpaid invoices count under accrual but not cash.
  expect(cash.data.data.grossRevenueCents).toBeLessThanOrEqual(accrual.data.data.grossRevenueCents);
});
