import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import { runTag, type Persona } from './fixtures';
import { api } from '../nightly/helpers/api';

/**
 * PR 4c — employee profile UI + pay frequency + per-frequency draft pay runs, on a DEPLOYED site (desktop viewport).
 *
 * Per market: create a TAGGED employee (biweekly, anchor 10 days ago), open its profile from the payroll list,
 * prove the catalog locale against the page's h1, assert the market's frequency label (Fortnightly in AU,
 * Bi-weekly in US/CA — in whatever locale the tenant renders), change the frequency to weekly in the UI and save,
 * then generate a draft pay run for THIS employee only and assert its period and payDate against dates computed
 * here from the anchor. The draft and the employee are deleted; nothing seeded is touched.
 */
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 900 } });

const PAYROLL = '/api/v1/agentbook-payroll';
const MARKETS: Array<{ persona: Exclude<Persona, 'fresh'>; jurisdiction: 'ca' | 'us' | 'au'; biweeklyKey: string }> = [
  { persona: 'maya', jurisdiction: 'ca', biweeklyKey: 'core_ui.bi_weekly' },
  { persona: 'alex', jurisdiction: 'us', biweeklyKey: 'core_ui.bi_weekly' },
  { persona: 'sydney', jurisdiction: 'au', biweeklyKey: 'core_ui.fortnightly' },
];

const DAY = 86_400_000;
const isoUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayUtcMs = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); };

for (const m of MARKETS) {
  test.describe(`employee UI — ${m.persona} (${m.jurisdiction})`, () => {
    const tag = runTag('E2EEMPUI');
    let context: BrowserContext | undefined;
    let page: Page;
    let t: CatalogT;
    let id = '';
    const runIds: string[] = [];
    const today = todayUtcMs();
    const anchor = isoUtc(today - 10 * DAY);

    test.beforeAll(async ({ browser }, testInfo) => {
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      expect(reason, reason ?? '').toBeNull();
      context = await newPersonaContext(browser, testInfo.project.use.baseURL);
      page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await loginAs(page, m.persona);
      await page.goto('/payroll');
      await settle(page);
      const loc = await pageLocales(page);
      t = catalogT(loc.stringLocale);
      await expect(page.getByRole('heading', { level: 1, name: t('nav.payroll') })).toBeVisible();
      const res = await api(page).post(`${PAYROLL}/employees`, {
        name: `${tag} Employee`, payRateCents: 5_200_000, payType: 'salary', payFrequency: 'biweekly', jurisdiction: m.jurisdiction,
      });
      expect(res.status, 'create employee').toBe(201);
      id = (res.data as { data: { id: string } }).data.id;
      const put = await api(page).put(`${PAYROLL}/employees/${id}`, { payAnchorDate: anchor });
      expect(put.status, 'set anchor').toBe(200);
    });

    test.afterAll(async () => {
      if (!context) return;
      try {
        for (const r of runIds) expect([200, 404]).toContain((await api(page).delete(`${PAYROLL}/pay-runs/${r}`)).status);
        if (id) expect([200, 404]).toContain((await api(page).delete(`${PAYROLL}/employees/${id}`)).status);
        const list = await api(page).get(`${PAYROLL}/employees`);
        expect(((list.data as { data: Array<{ name: string }> }).data).filter((e) => e.name.includes(tag))).toEqual([]);
      } finally { await context.close(); }
    });

    test('payroll list shows the market frequency label and links to the profile', async () => {
      await page.goto('/payroll');
      await settle(page);
      const link = page.getByRole('link', { name: `${tag} Employee` });
      await expect(link).toBeVisible();
      await expect(link.locator('xpath=following-sibling::p[1]')).toContainText(t(m.biweeklyKey));
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/payroll/employees/${id}$`));
      await expect(page.getByRole('heading', { level: 1, name: t('core_ui.employee_profile') })).toBeVisible();
    });

    test('profile shows the market tax-id label and edits the frequency', async () => {
      const taxKey = { au: 'core_ui.tax_file_number_tfn', ca: 'core_ui.social_insurance_number_sin', us: 'core_ui.social_security_number_ssn' }[m.jurisdiction];
      await expect(page.getByLabel(t(taxKey), { exact: true })).toBeVisible();
      const sel = page.getByLabel(t('core_ui.pay_frequency'), { exact: true });
      await expect(sel.locator('option:checked')).toHaveText(t(m.biweeklyKey));
      await sel.selectOption('weekly');
      await page.getByRole('button', { name: t('common.save'), exact: true }).click();
      await expect(page.getByText(t('core_ui.profile_saved'))).toBeVisible();
      const got = await api(page).get(`${PAYROLL}/employees/${id}`);
      expect((got.data as { data: { payFrequency: string } }).data.payFrequency).toBe('weekly');
    });

    test('draft pay run for this employee has the computed weekly period and payDate', async () => {
      const asOf = isoUtc(today);
      const res = await api(page).post(`${PAYROLL}/pay-runs`, { generate: 'drafts', asOf, employeeIds: [id] });
      expect(res.status).toBe(201);
      const runs = (res.data as { data: { runs: Array<{ id: string; periodStart: string; periodEnd: string; payDate: string; payFrequency: string; status: string; stubs: Array<{ employeeId: string; grossCents: number }> }> } }).data.runs;
      expect(runs).toHaveLength(1);
      const r = runs[0];
      runIds.push(r.id);
      // anchor = today-10 → weekly periods start at anchor, anchor+7 → today falls in [anchor+7, anchor+13].
      const start = isoUtc(today - 3 * DAY), end = isoUtc(today + 3 * DAY);
      expect([r.periodStart.slice(0, 10), r.periodEnd.slice(0, 10), r.payDate.slice(0, 10)]).toEqual([start, end, end]);
      expect(r.payFrequency).toBe('weekly');
      expect(r.status).toBe('draft');
      expect(r.stubs.map((s) => s.employeeId)).toEqual([id]);
      expect(r.stubs[0].grossCents).toBe(100_000); // 52,000.00 / 52 at the edited weekly frequency
    });
  });
}
