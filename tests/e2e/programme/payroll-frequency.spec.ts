import { test, expect, type Page } from '@playwright/test';
import { catalogT, pageLocales, settle } from '../mobile-app/helpers';
import { runTag } from '../mobile-app/fixtures';
import { api } from '../nightly/helpers/api';
import { PAYROLL, PERSONAS, openPersona, returnLines, linesDelta, type Ctx, type ReturnLines } from './lib';

/**
 * J-payroll (R-EMP-1, R-EMP-3, R-EMP-4) — pay frequency → draft pay runs → statutory bucket, across PR 4a (schema),
 * 4b (employee API), 4c (UI + per-frequency drafts) and 4d (pay date), on a DEPLOYED site for maya, alex, sydney.
 *
 * Only what tagged fixtures can prove WITHOUT processing real payroll (a processed run cannot be undone on prod and
 * merges into shared deposit rows; see tests/e2e/mobile-app/paydate.spec.ts):
 *   - a TAGGED salaried employee, Fortnightly (AU) / Bi-weekly (US/CA) — the label read on the payroll list in the
 *     tenant's locale; payAnchorDate in a far-past year unique to this run, so no real run can share its periods;
 *   - draft 1 (asOf in the first cycle) and draft 2 (the next cycle) get exactly the period/payDate computed here
 *     from the anchor (14-day cycles, payDate = period end), for THIS employee only (employeeIds);
 *   - a pay-rate edit between them: draft 1's stub keeps the old gross, draft 2 has the new (edits apply from the
 *     next draft run only); an unknown key on the profile PUT is refused;
 *   - draft 2's period starts in Q1 and ends (= pays) in Q2: statutory reports bucket by PAY date — AU BAS W1/W2
 *     for Q1 move by draft 1 only, Q2 by draft 2 only; year-end forms (paid runs only) never list the employee.
 * Teardown deletes only the drafts it created and the employee; BAS for both quarters returns to baseline.
 */
test.describe.configure({ mode: 'serial' });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
interface Stub { employeeId: string; grossCents: number; federalTaxCents: number }
interface Run { id: string; periodStart: string; periodEnd: string; payDate: string; payFrequency: string; status: string; created: boolean; stubs: Stub[] }

/** A far-past year (1931..1999) unique to this run's tag: no real pay period can be in it. */
function yearFor(tag: string): number {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1931 + (h % 69);
}

for (const persona of PERSONAS) {
  test.describe(`payroll frequency journey — ${persona}`, () => {
    let ctx: Ctx;
    const tag = runTag(`E2EJPAY${persona.slice(0, 2).toUpperCase()}`);
    const Y = yearFor(tag);
    // Anchor Mar 11: cycle 1 = Mar 11..Mar 24 (Q1); cycle 2 = Mar 25..Apr 7 (starts Q1, pays Q2).
    const anchorMs = Date.UTC(Y, 2, 11);
    const c1 = { start: iso(anchorMs), end: iso(anchorMs + 13 * DAY) };
    const c2 = { start: iso(anchorMs + 14 * DAY), end: iso(anchorMs + 27 * DAY) };
    const q1 = `${Y}-02-15`, q2 = `${Y}-05-15`;
    let id = '';
    const runIds: string[] = [];
    let bas0: { q1: ReturnLines; q2: ReturnLines } | null = null;
    const label = () => (ctx.cfg.jurisdiction === 'au' ? 'core_ui.fortnightly' : 'core_ui.bi_weekly');

    const draft = async (page: Page, asOf: string): Promise<Run> => {
      const res = await api(page).post(`${PAYROLL}/pay-runs`, { generate: 'drafts', asOf, employeeIds: [id] });
      expect(res.status, `draft run asOf ${asOf}`).toBe(201);
      const runs = res.data.data.runs as Run[];
      expect(runs, 'one draft for one employee').toHaveLength(1);
      expect(runs[0].created, 'the draft is new (a unique far-past period), never an existing run').toBe(true);
      runIds.push(runs[0].id);
      return runs[0];
    };
    const getRun = async (rid: string): Promise<Run> => (await api(ctx.page).get(`${PAYROLL}/pay-runs/${rid}`)).data.data as Run;

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
      if (ctx.cfg.jurisdiction === 'au') bas0 = { q1: await returnLines(ctx.page, 'au', q1), q2: await returnLines(ctx.page, 'au', q2) };
      const res = await api(ctx.page).post(`${PAYROLL}/employees`, {
        name: `${tag} Employee`, payRateCents: 5_200_000, payType: 'salary', payFrequency: 'biweekly', jurisdiction: ctx.cfg.jurisdiction,
      });
      expect(res.status, 'create tagged employee').toBe(201);
      id = res.data.data.id;
      expect((await api(ctx.page).put(`${PAYROLL}/employees/${id}`, { payAnchorDate: c1.start })).status, 'set anchor').toBe(200);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      const page = ctx.page;
      try {
        for (const r of runIds) {
          expect([200, 404]).toContain((await api(page).delete(`${PAYROLL}/pay-runs/${r}`)).status);
          expect((await api(page).get(`${PAYROLL}/pay-runs/${r}`)).status, `draft ${r} removed`).toBe(404);
        }
        if (id) expect([200, 404]).toContain((await api(page).delete(`${PAYROLL}/employees/${id}`)).status);
        const list = await api(page).get(`${PAYROLL}/employees`);
        expect((list.data.data as Array<{ name: string }>).filter((e) => e.name.includes(tag)), 'no tagged employee left').toEqual([]);
        if (bas0) {
          expect(linesDelta(bas0.q1, await returnLines(page, 'au', q1)), `BAS ${Y}Q1 back at baseline`).toMatchObject({ w1: 0, w2: 0 });
          expect(linesDelta(bas0.q2, await returnLines(page, 'au', q2)), `BAS ${Y}Q2 back at baseline`).toMatchObject({ w1: 0, w2: 0 });
        }
      } finally { await ctx.context.close().catch(() => undefined); }
    });

    test('the payroll list shows the market frequency label for the tagged employee', async () => {
      const page = ctx.page;
      await page.setViewportSize({ width: 1280, height: 900 });
      try {
        await page.goto('/payroll');
        await settle(page);
        const t = catalogT((await pageLocales(page)).stringLocale);
        await expect(page.getByRole('main').getByRole('heading', { level: 1, name: t('nav.payroll') })).toBeVisible();
        const link = page.getByRole('link', { name: `${tag} Employee` });
        await expect(link).toBeVisible();
        await expect(link.locator('xpath=following-sibling::p[1]')).toContainText(t(label()));
      } finally {
        await page.setViewportSize({ width: 390, height: 844 });
      }
      const emp = (await api(page).get(`${PAYROLL}/employees/${id}`)).data.data;
      expect([emp.payFrequency, String(emp.payAnchorDate).slice(0, 10)]).toEqual(['biweekly', c1.start]);
      const bad = await api(page).put(`${PAYROLL}/employees/${id}`, { notARealField: 1 });
      expect(bad.status, 'unknown profile key refused').toBe(400);
    });

    test('draft 1 has the anchor-computed 14-day period; a rate edit leaves it alone and applies to draft 2', async () => {
      const page = ctx.page;
      const r1 = await draft(page, iso(anchorMs + 4 * DAY));
      expect([r1.periodStart.slice(0, 10), r1.periodEnd.slice(0, 10), r1.payDate.slice(0, 10), r1.payFrequency, r1.status])
        .toEqual([c1.start, c1.end, c1.end, 'biweekly', 'draft']);
      expect(r1.stubs.map((s) => [s.employeeId, s.grossCents])).toEqual([[id, 5_200_000 / 26]]);

      expect((await api(page).put(`${PAYROLL}/employees/${id}`, { payRateCents: 7_800_000 })).status, 'edit pay rate').toBe(200);
      const again = await getRun(r1.id);
      expect(again.stubs.map((s) => s.grossCents), 'the existing draft keeps the old gross').toEqual([5_200_000 / 26]);

      const r2 = await draft(page, iso(anchorMs + 20 * DAY));
      expect([r2.periodStart.slice(0, 10), r2.periodEnd.slice(0, 10), r2.payDate.slice(0, 10), r2.payFrequency])
        .toEqual([c2.start, c2.end, c2.end, 'biweekly']);
      expect(r2.stubs.map((s) => [s.employeeId, s.grossCents]), 'the next draft has the new rate').toEqual([[id, 7_800_000 / 26]]);
    });

    test('statutory bucketing by pay date across the Q1/Q2 boundary; year-end lists only paid runs', async () => {
      const page = ctx.page;
      const [r1, r2] = await Promise.all(runIds.map(getRun));
      expect(r2.periodStart.slice(0, 7), 'draft 2 starts in March').toBe(`${Y}-03`);
      expect(r2.payDate.slice(0, 7), 'and pays in April').toBe(`${Y}-04`);
      if (bas0) {
        const sum = (r: Run, k: 'grossCents' | 'federalTaxCents') => r.stubs.reduce((a, s) => a + s[k], 0);
        const dq1 = linesDelta(bas0.q1, await returnLines(page, 'au', q1));
        const dq2 = linesDelta(bas0.q2, await returnLines(page, 'au', q2));
        expect([dq1.w1, dq1.w2], `BAS ${Y}Q1 W1/W2 = draft 1 only (draft 2 starts in Q1 but pays in Q2)`).toEqual([sum(r1, 'grossCents'), sum(r1, 'federalTaxCents')]);
        expect([dq2.w1, dq2.w2], `BAS ${Y}Q2 W1/W2 = draft 2 (its pay date)`).toEqual([sum(r2, 'grossCents'), sum(r2, 'federalTaxCents')]);
        const basis = (await api(page).get(`/api/v1/agentbook-tax/au/bas-return?periodStart=${Y}-04-01&periodEnd=${Y}-06-30`)).data.data.wagesBasis;
        expect(basis).toBe('pay_date');
      }
      const ye = await api(page).get(`${PAYROLL}/year-end?year=${Y}`);
      expect(ye.status).toBe(200);
      expect(ye.data.data.reportingBasis).toBe('pay_date');
      expect((ye.data.data.forms as Array<{ employeeId?: string }>).filter((f) => f.employeeId === id), 'drafts never reach year-end forms').toEqual([]);
    });
  });
}
