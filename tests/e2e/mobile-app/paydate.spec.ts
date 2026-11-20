import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, loginUnavailableReason, newPersonaContext } from './helpers';
import type { Persona } from './fixtures';
import { api } from '../nightly/helpers/api';

/**
 * PR 4d — statutory reports bucket pay runs by payDate ?? periodEnd, proved READ-ONLY on a deployed site.
 *
 * Why read-only (no fixture pay run): on prod a pay run cannot be undone. There is no pay-run DELETE route;
 * POST pay-runs drafts a stub for EVERY active employee (seeded ones included, not just a tagged fixture);
 * processing posts a journal entry and ADDS into the tenant's existing AbPayrollTaxDeposit rows (941/BAS/SG/940
 * share one row per period), so it can't be reversed by deleting the fixture. On main the create route also
 * takes no payDate (PR 4c writes it), so a "period end in one quarter, paid in the next" run can't be made via the
 * API. The quarter/year-boundary cases are proved by the vitest fixture
 * (apps/web-next/src/__tests__/api/v1/agentbook-payroll/paydate-statutory-buckets.test.ts).
 *
 * Here each persona's report endpoints are recomputed from its own pay-run list by statutory date and must agree:
 * year-end forms (paid runs, per UTC year) for every market; BAS W1/W2 per quarter (all runs, as the route reads
 * them) and the STP pay event's FY/payDate for the AU tenant. The test records how many runs actually have a pay
 * date that differs from the period end, so a report shows whether the boundary was exercised on live data.
 */
test.describe.configure({ mode: 'serial' });

const PAYROLL = '/api/v1/agentbook-payroll';

interface Stub { employeeId: string; grossCents: number; federalTaxCents: number }
interface Run { id: string; status: string; periodEnd: string; payDate?: string | null; stubs: Stub[] }

const statutory = (r: Run) => new Date(r.payDate ?? r.periodEnd);
const quarterOf = (d: Date) => ({ y: d.getUTCFullYear(), q: Math.floor(d.getUTCMonth() / 3) });
const iso = (d: Date) => d.toISOString().slice(0, 10);

const MARKETS: Array<{ persona: Exclude<Persona, 'fresh'>; jurisdiction: 'ca' | 'us' | 'au' }> = [
  { persona: 'maya', jurisdiction: 'ca' },
  { persona: 'alex', jurisdiction: 'us' },
  { persona: 'sydney', jurisdiction: 'au' },
];

for (const m of MARKETS) {
  test.describe(`pay-date reporting — ${m.persona} (${m.jurisdiction})`, () => {
    let context: BrowserContext | undefined;
    let page: Page;
    let runs: Run[] = [];

    test.beforeAll(async ({ browser }, testInfo) => {
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      expect(reason, reason ?? '').toBeNull();
      context = await newPersonaContext(browser, testInfo.project.use.baseURL);
      page = await context.newPage();
      await loginAs(page, m.persona);
      await page.goto('/app/capture');
      const res = await api(page).get(`${PAYROLL}/pay-runs`);
      expect(res.status, 'list pay runs').toBe(200);
      runs = (res.data as { data: Run[] }).data;
      const shifted = runs.filter((r) => r.payDate && iso(new Date(r.payDate)) !== iso(new Date(r.periodEnd))).length;
      testInfo.annotations.push({ type: 'paydate-shifted-runs', description: `${shifted} of ${runs.length}` });
    });
    test.afterAll(async () => { await context?.close(); });

    test('year-end forms contain exactly the employees paid in that year (by pay date)', async () => {
      // The list route returns at most 50 runs; only check when it was not truncated.
      test.info().annotations.push({ type: 'runs', description: String(runs.length) });
      expect(runs.length, 'pay-run list not truncated (else the recomputation is partial)').toBeLessThan(50);
      const years = new Set<number>([new Date().getUTCFullYear(), ...runs.map((r) => statutory(r).getUTCFullYear())]);
      for (const year of years) {
        const res = await api(page).get(`${PAYROLL}/year-end?year=${year}`);
        expect(res.status, `year-end ${year}`).toBe(200);
        const got = ((res.data as { data: { forms: Array<{ employeeId?: string }> } }).data.forms)
          .map((f) => f.employeeId).filter(Boolean).sort();
        const want = [...new Set(runs
          .filter((r) => r.status === 'paid' && statutory(r).getUTCFullYear() === year)
          .flatMap((r) => r.stubs.map((s) => s.employeeId)))].sort();
        expect(got, `employees with ${year} forms`).toEqual(want);
      }
    });

    if (m.jurisdiction === 'au') {
      test('BAS W1/W2 per quarter equal the runs whose pay date falls in it', async () => {
        const quarters = new Map<string, { y: number; q: number }>();
        const now = quarterOf(new Date());
        quarters.set(`${now.y}-${now.q}`, now);
        for (const r of runs) { const k = quarterOf(statutory(r)); quarters.set(`${k.y}-${k.q}`, k); }
        for (const { y, q } of quarters.values()) {
          const start = new Date(Date.UTC(y, q * 3, 1));
          const end = new Date(Date.UTC(y, q * 3 + 3, 0));
          const inQ = runs.filter((r) => { const k = quarterOf(statutory(r)); return k.y === y && k.q === q; });
          const w1 = inQ.reduce((a, r) => a + r.stubs.reduce((b, s) => b + s.grossCents, 0), 0);
          const w2 = inQ.reduce((a, r) => a + r.stubs.reduce((b, s) => b + s.federalTaxCents, 0), 0);
          const res = await api(page).get(`/api/v1/agentbook-tax/au/bas-return?periodStart=${iso(start)}&periodEnd=${iso(end)}`);
          expect(res.status, `BAS ${y}Q${q + 1}`).toBe(200);
          const d = (res.data as { data: { w1TotalWagesCents: number; w2PaygWithheldCents: number; wagesBasis?: string } }).data;
          expect(d.wagesBasis).toBe('pay_date');
          expect([d.w1TotalWagesCents, d.w2PaygWithheldCents], `BAS ${y}Q${q + 1} W1/W2`).toEqual([w1, w2]);
        }
      });

      test('STP pay event: FY and payDate follow the pay date; period end is reported separately', async () => {
        const res = await api(page).get(`${PAYROLL}/au/stp`);
        if (runs.length === 0) { expect(res.status, 'no run → 404').toBe(404); return; }
        expect(res.status).toBe(200);
        const d = (res.data as { data: { payRunId: string; financialYear: number; payDate: string; periodEnd: string; reportingBasis: string } }).data;
        const run = runs.find((r) => r.id === d.payRunId);
        expect(run, 'STP target is one of the listed runs').toBeTruthy();
        const pay = statutory(run!);
        expect(d.reportingBasis).toBe('pay_date');
        expect(d.payDate).toBe(iso(pay));
        expect(d.periodEnd).toBe(iso(new Date(run!.periodEnd)));
        expect(d.financialYear).toBe(pay.getUTCMonth() >= 6 ? pay.getUTCFullYear() + 1 : pay.getUTCFullYear());
      });
    }
  });
}
