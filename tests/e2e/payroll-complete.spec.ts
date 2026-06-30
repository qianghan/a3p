/**
 * Follow-on F4 e2e — payroll completeness on the deployed app.
 *
 * As Maya: add an employee, run + process a pay run, then assert the ledger
 * split balances (net + withheld === gross), a tax deposit was accrued, and
 * a year-end form is produced for the employee.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

const P = '/api/v1/agentbook-payroll';

test('payroll: balanced ledger split + tax deposit + year-end form', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const emp = await api(page, 'POST', `${P}/employees`, {
    name: 'F4 Employee', payRateCents: 90_000_00, payType: 'salary', payFrequency: 'biweekly', jurisdiction: 'us',
  });
  expect(emp.status, JSON.stringify(emp.data)).toBe(201);

  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - 14);
  const run = await api(page, 'POST', `${P}/pay-runs`, {
    periodStart: start.toISOString().slice(0, 10), periodEnd: now.toISOString().slice(0, 10),
  });
  expect(run.status, JSON.stringify(run.data)).toBe(201);
  const runId = run.data.data.id;

  const processed = await api(page, 'POST', `${P}/pay-runs/${runId}/process`, {});
  expect(processed.status, JSON.stringify(processed.data)).toBe(200);
  expect(processed.data.data.status).toBe('paid');
  // Ledger split balances.
  const ledger = processed.data.data.ledger;
  expect(ledger.grossCents).toBeGreaterThan(0);
  expect(ledger.netCents + ledger.withheldCents).toBe(ledger.grossCents);
  expect(ledger.withheldCents).toBeGreaterThan(0);

  // A tax-deposit obligation was accrued for the tenant's jurisdiction
  // (941 for US, t4 for Maya's CA tenant) with a positive amount + due date.
  const deps = await api(page, 'GET', `${P}/tax-deposits`);
  expect(deps.status).toBe(200);
  expect(deps.data.data.some((d: any) => d.amountCents > 0 && d.dueDate && d.periodLabel)).toBe(true);

  // Year-end produces a W-2 for the employee with non-zero wages.
  const ye = await api(page, 'GET', `${P}/year-end?year=${now.getFullYear()}`);
  expect(ye.status).toBe(200);
  const form = ye.data.data.forms.find((f: any) => f.employeeName === 'F4 Employee');
  expect(form).toBeTruthy();
  expect(form.formType).toBe('W-2');
  expect(form.boxes.grossWagesCents).toBeGreaterThan(0);
});
