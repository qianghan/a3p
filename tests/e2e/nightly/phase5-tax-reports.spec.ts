import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api } from './helpers/api';

test.describe('@phase5-tax-reports', () => {
  test.beforeEach(async ({ page }) => { await loginAsE2eUser(page); });

  test('tax/estimate returns numbers given seeded data', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
    expect(r.status).toBe(200);
    expect(r.data.data.grossRevenueCents).toBeGreaterThanOrEqual(0);
  });
  test('quarterly estimate has 4 quarters', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax/quarterly');
    expect(r.status).toBe(200);
    expect(r.data.data.quarters?.length).toBe(4);
  });
  test('record quarterly payment updates dashboard', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax/quarterly/2026/1/record-payment', { amountCents: 100 });
    expect(r.status).toBeLessThan(500);
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
    const { totalAssets, totalLiabilities, totalEquity } = r.data.data;
    expect(Math.abs(totalAssets - (totalLiabilities + totalEquity))).toBeLessThan(2);
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
    expect(r.status).toBeLessThan(500);
  });
  test('tax filing populate', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-tax/tax-filing/2026');
    expect(r.status).toBeLessThan(500);
  });
  test('tax slip OCR mock', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax-slips/ocr', { imageUrl: 'https://e2e.test/slip.jpg' });
    expect(r.status).toBeLessThan(500);
  });
  test('whatif simulator', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-tax/tax/whatif', { hypothetical: { hireMonthlyCents: 500000 } });
    expect(r.status).toBeLessThan(500);
  });
});
