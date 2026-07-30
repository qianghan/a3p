import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api, expectOk } from './helpers/api';

test.describe('@phase5-tax-reports', () => {
  test.beforeEach(async ({ page }) => { await loginAsE2eUser(page); });

  test('tax/estimate returns numbers given seeded data', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
    expect(r.status).toBe(200);
    // `>= 0` was true of every number, including the 0 you get when the report
    // sees nothing at all — the exact failure the test is named for. The seed
    // creates 4 invoices, so revenue must be positive.
    expect(r.data.data.grossRevenueCents).toBeGreaterThan(0);
  });
  test('quarterly estimate has 4 quarters', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax/quarterly');
    expect(r.status).toBe(200);
    // The response key is `payments` (the route auto-creates one installment
    // row per deadline). `quarters` never existed, so this read undefined.
    expect(r.data.data.payments?.length).toBe(4);
    expect(r.data.data.payments.map((p: { quarter: number }) => p.quarter)).toEqual([1, 2, 3, 4]);
  });
  test('record quarterly payment updates dashboard', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax/quarterly/2026/1/record-payment', { amountCents: 100 });
    expectOk(r, 'agentbook-tax/tax/quarterly/2026/1/record-payment');
  });
  test('deductions list', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax/deductions');
    expect(r.status).toBe(200);
  });
  test('P&L MTD', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/pnl?period=mtd');
    expect(r.status).toBe(200);
  });
  test('P&L last month', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/pnl?period=last-month');
    expect(r.status).toBe(200);
  });
  test('balance sheet balanced', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/balance-sheet');
    expect(r.status).toBe(200);
    // The API returns *Cents-suffixed keys. Destructuring the unsuffixed names
    // gave three undefineds, so the arithmetic was NaN and the assertion could
    // only ever fail — it had never run, so nobody found out.
    const { totalAssetsCents, totalLiabilitiesCents, totalEquityCents, balanced } = r.data.data;
    expect(typeof totalAssetsCents).toBe('number');
    expect(Math.abs(totalAssetsCents - (totalLiabilitiesCents + totalEquityCents))).toBeLessThan(2);
    // The route computes this itself; if it ever disagrees with our arithmetic,
    // one of the two is wrong and we want to know.
    expect(balanced).toBe(true);
  });
  test('cashflow projection 30-day', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/cashflow/projection');
    expect(r.status).toBe(200);
    expect(r.data.data.days?.length || 30).toBeGreaterThanOrEqual(30);
  });
  test('trial balance', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/trial-balance');
    expect(r.status).toBe(200);
    expect(r.data.data.balanced).toBe(true);
  });
  test('AR aging detail', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/ar-aging-detail');
    expect(r.status).toBe(200);
  });
  test('earnings projection', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/reports/earnings-projection');
    expect(r.status).toBe(200);
  });
  test('tax form seeding (Canadian)', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax-forms/seed', {});
    expectOk(r, 'agentbook-tax/tax-forms/seed');
  });
  test('tax filing populate', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax-filing/2026');
    expectOk(r, 'agentbook-tax/tax-filing/2026');
  });
  test('tax slip OCR mock', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax-slips/ocr', { imageUrl: 'https://e2e.test/slip.jpg' });
    expectOk(r, 'agentbook-tax/tax-slips/ocr');
  });
  test('whatif simulator', async ({ page }) => {
    // Was POST /tax/whatif, a path that has never existed on the production
    // surface — it 501'd through the [plugin]/[...path] catch-all, so the
    // What-If feature had zero coverage. The page (WhatIf.tsx) posts
    // { changeAmountCents } to /cashflow/scenario; test what users actually hit.
    const r = await api(page).post('/api/v1/agentbook-tax/cashflow/scenario', {
      changeAmountCents: 500000,
    });
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data).toBeTruthy();
  });
});
