/**
 * Phase 5 e2e — payroll on the deployed app.
 *
 * As Maya: add a salaried US employee, run a pay run (which computes a stub),
 * and assert the withholding is sane (gross = federal + fica + state + net,
 * net < gross, taxes > 0), then process the run to 'paid'.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

const P = '/api/v1/agentbook-payroll';

test('payroll: add employee, run + process a pay run', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Add a salaried US employee at $78k biweekly.
  const emp = await apiPost(page, `${P}/employees`, {
    name: 'E2E Employee', payRateCents: 78_000_00, payType: 'salary', payFrequency: 'biweekly', jurisdiction: 'us',
  });
  expect(emp.status, JSON.stringify(emp.data)).toBe(201);

  // Run a pay run for the last two weeks.
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - 14);
  const run = await apiPost(page, `${P}/pay-runs`, {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
  });
  expect(run.status, JSON.stringify(run.data)).toBe(201);
  const runId = run.data.data.id;
  const stub = run.data.data.stubs.find((s: any) => s.employeeName === 'E2E Employee');
  expect(stub).toBeTruthy();

  // Withholding sanity: balanced, taxes withheld, net below gross.
  expect(stub.grossCents).toBe(Math.round(78_000_00 / 26));
  expect(stub.federalTaxCents).toBeGreaterThan(0);
  expect(stub.ficaCents).toBeGreaterThan(0);
  expect(stub.federalTaxCents + stub.ficaCents + stub.stateTaxCents + stub.netCents).toBe(stub.grossCents);
  expect(stub.netCents).toBeLessThan(stub.grossCents);

  // Process the run → paid.
  const processed = await apiPost(page, `${P}/pay-runs/${runId}/process`, {});
  expect(processed.status).toBe(200);
  expect(processed.data.data.status).toBe('paid');
});
