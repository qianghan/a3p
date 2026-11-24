import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, loginUnavailableReason, newPersonaContext, settle } from './helpers';
import {
  PERSONA_CURRENCY,
  deleteExpenseQuietly,
  getExpense,
  listCategoryAccounts,
  pnlSnapshot,
  runTag,
  todayIso,
  type ExpenseAccount,
  type Persona,
} from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';
// Expected figures come from the engine the server runs, from source.
import { computeLineTax, defaultTaxCode } from '../../../packages/agentbook-jurisdictions/src/tax-codes';
import { taxYearOfDate } from '../../../packages/agentbook-jurisdictions/src/restatement-year';

/**
 * PR 2c — opt-in tax restatement, proved on a DEPLOYED site for maya (CA) and sydney (AU).
 *
 * Per persona, on ONE tagged fixture only (seeded data is never restated — apply is called with
 * expenseIds = [the fixture], never for the whole year):
 *   create a legacy-shaped expense today (taxCode null, gross with the printed tax, booked DR category | CR cash
 *   at gross) → preview lists it with the engine's recoverable tax → the Business Profile card renders →
 *   apply → P&L category −recoverable, 2100 +recoverable, cash unchanged, books balanced → the return line moves as
 *   the engine says (CA meals: line 108 falls from the full tax to the 50% ITC; AU: 1B unchanged because an untyped
 *   row already counted its GST — the restatement moves the P&L, not the BAS) → a second apply is a no-op →
 *   delete the fixture → every touched figure is back to the pre-fixture value.
 *
 * Preconditions (read only): both personas are GST/HST registrants (agentbook/seed-persona-tax-registration.ts).
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';
const TAX = '/api/v1/agentbook-tax';

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface Ctx { context: BrowserContext; page: Page; cfg: { jurisdiction: 'au' | 'ca'; region: string | null; gstRegistered: boolean | null; qstRegistered: boolean | null } }

async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true && res.data.data.totalDebits === res.data.data.totalCredits, byCode };
}
const d = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);

function quarterOf(iso: string): string {
  const x = new Date(`${iso}T00:00:00Z`);
  const q = Math.floor(x.getUTCMonth() / 3);
  const s = new Date(Date.UTC(x.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(x.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10);
  return `periodStart=${s}&periodEnd=${e}`;
}
/** The return line a purchase's input-tax credit lands on: AU BAS 1B, CA line 108 (+ QST ITR). */
async function returnItc(page: Page, j: 'au' | 'ca', iso: string): Promise<number> {
  const res = await api(page).get(`${TAX}/${j === 'au' ? 'au/bas-return' : 'ca/gst-hst-return'}?${quarterOf(iso)}`);
  expectOk(res, 'sales tax return');
  const r = res.data.data;
  return j === 'au' ? r.label1BGstOnPurchasesCents : r.line108ItcCents + (r.qstItrCents ?? 0);
}
const taxYear = (j: string, iso: string) => taxYearOfDate(j, iso);

for (const persona of ['maya', 'sydney'] as Persona[]) {
  test.describe(`tax restatement — ${persona}`, () => {
    let ctx: Ctx | undefined;
    const tag = runTag(`E2ERST${persona.slice(0, 2).toUpperCase()}`);
    const created: string[] = [];

    test.beforeAll(async ({ browser }, testInfo) => {
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      test.skip(reason !== null, reason ?? '');
      const context = await newPersonaContext(browser, testInfo.project.use.baseURL);
      const page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app');
      await settle(page);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const cfgRes = await api(page).get(`${CORE}/tenant-config`);
      expectOk(cfgRes, 'tenant config');
      const c = cfgRes.data.data;
      expect(c.gstRegistered, `${persona} must be a GST/HST registrant (run agentbook/seed-persona-tax-registration.ts --apply)`).toBe(true);
      ctx = { context, page, cfg: { jurisdiction: c.jurisdiction, region: c.region ?? null, gstRegistered: c.gstRegistered, qstRegistered: c.qstRegistered ?? null } };
    });

    test.afterAll(async () => {
      if (!ctx) return;
      for (const id of created) await deleteExpenseQuietly(ctx.page, id);
      await ctx.context.close().catch(() => {});
    });

    test('a legacy gross expense restates by amend-reversal + 3-line repost; the return moves as the engine says; delete unwinds', async () => {
      const { page, cfg } = ctx!;
      const j = cfg.jurisdiction;
      const date = todayIso();
      const year = taxYear(j, date);

      // CA: a meals category (50% ITC) so the return line moves; AU: any plain category.
      const cats = await listCategoryAccounts(page);
      const meals = cats.find((x) => /meal|entertain/i.test(`${x.name} ${(x as { taxCategory?: string }).taxCategory ?? ''}`));
      const cat: ExpenseAccount = j === 'ca' && meals ? meals : (cats.find((x) => !/meal|entertain/i.test(x.name)) as ExpenseAccount);
      expect(cat, 'persona has a usable expense category').toBeTruthy();
      const isMeal = j === 'ca' && cat === meals;

      const gross = 11000 + Math.floor(Math.random() * 50) * 10;
      const engine = computeLineTax({
        jurisdiction: j, region: cfg.region, taxCode: defaultTaxCode(j, cfg.region), amountCents: gross, inclusive: true, isMeal,
        registration: { gstRegistered: cfg.gstRegistered, qstRegistered: cfg.qstRegistered },
      });
      const rec = engine.recoverableTaxCents;
      expect(rec, 'the engine credits some tax').toBeGreaterThan(0);

      const tb0 = await trialBalance(page);
      const pnl0 = await pnlSnapshot(page);
      const itc0 = await returnItc(page, j, date);

      // 1. Legacy-shaped fixture: explicitly untyped, gross with the printed tax.
      const res = await api(page).post(`${EXPENSE}/expenses`, {
        amountCents: gross, taxAmountCents: engine.taxCents, taxCode: null, date,
        vendor: `${tag} Vendor`, description: `${tag} legacy`, currency: PERSONA_CURRENCY[persona],
        categoryId: cat.id, categorySource: 'user',
      });
      expectOk(res, 'create legacy expense');
      const id = res.data.data.id as string;
      created.push(id);
      const row0 = (await getExpense(page, id)).data.data;
      expect([row0.taxCode ?? null, row0.taxAmountCents, row0.recoverableTaxCents ?? 0]).toEqual([null, engine.taxCents, 0]);
      const tb1 = await trialBalance(page);
      expect([d(tb0, tb1, '2100'), d(tb0, tb1, '1000')], 'legacy posting: no 2100, cash −gross').toEqual([0, 0 - gross]);
      const itc1 = await returnItc(page, j, date);
      expect(itc1 - itc0, 'an untyped row counts its whole printed tax on the return').toBe(engine.taxCents);

      // 2. Preview lists it with the engine's figure.
      const prev = await api(page).get(`${TAX}/restatement?year=${year}`);
      expectOk(prev, 'preview');
      const mine = (prev.data.data.eligible as Array<{ expenseId: string; recoverableTaxCents: number; taxCode: string }>).find((r) => r.expenseId === id);
      expect(mine, 'the fixture is eligible').toBeTruthy();
      expect(mine!.recoverableTaxCents).toBe(rec);

      // The Business Profile card renders the preview in the browser.
      await page.goto('/settings?tab=agentbook&subtab=profile');
      await expect(page.getByTestId('restatement-card')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('restatement-preview')).toBeVisible({ timeout: 30_000 });

      // 3. Apply — ONLY the fixture.
      const pnl1 = await pnlSnapshot(page);
      const applied = await api(page).post(`${TAX}/restatement`, { year, expenseIds: [id] });
      expectOk(applied, 'apply');
      expect((applied.data.data.restated as Array<{ expenseId: string }>).map((r) => r.expenseId)).toEqual([id]);
      expect([applied.data.data.failed, applied.data.data.remaining]).toEqual([[], 0]);
      const tb2 = await trialBalance(page);
      const pnl2 = await pnlSnapshot(page);
      expect((pnl2.expenseByAccount[cat.id] ?? 0) - (pnl1.expenseByAccount[cat.id] ?? 0), 'P&L category falls by the recoverable tax').toBe(0 - rec);
      expect([d(tb1, tb2, '2100'), d(tb1, tb2, '1000')], '2100 +recoverable, cash unchanged').toEqual([rec, 0]);
      expect(tb2.balanced, 'trial balance balances').toBe(true);
      const row1 = (await getExpense(page, id)).data.data;
      expect([row1.taxCode, row1.recoverableTaxCents, row1.taxAmountCents, row1.amountCents]).toEqual([defaultTaxCode(j, cfg.region), rec, engine.taxCents, gross]);
      const itc2 = await returnItc(page, j, date);
      expect(itc2 - itc1, 'return line moves from the printed tax to the recoverable tax').toBe(rec - engine.taxCents);

      // 4. Second apply is a no-op.
      const again = await api(page).post(`${TAX}/restatement`, { year, expenseIds: [id] });
      expectOk(again, 'second apply');
      expect(again.data.data.restated).toEqual([]);
      const tb3 = await trialBalance(page);
      for (const code of ['2100', '1000']) expect(d(tb2, tb3, code), `no-op on ${code}`).toBe(0);

      // 5. Delete the fixture: everything back to before it existed.
      expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete fixture');
      created.splice(created.indexOf(id), 1);
      const tb4 = await trialBalance(page);
      const pnl4 = await pnlSnapshot(page);
      for (const code of ['2100', '1000']) expect(d(tb0, tb4, code), `${code} back to baseline`).toBe(0);
      expect((pnl4.expenseByAccount[cat.id] ?? 0) - (pnl0.expenseByAccount[cat.id] ?? 0), 'P&L category back to baseline').toBe(0);
      expect(await returnItc(page, j, date), 'return back to baseline').toBe(itc0);
      expect(tb4.balanced).toBe(true);
    });
  });
}
