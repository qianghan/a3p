import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import {
  PERSONA_CURRENCY,
  amountInputText,
  countByQuery,
  deleteExpenseQuietly,
  diffTotals,
  getExpense,
  listCategoryAccounts,
  movedAccounts,
  pnlSnapshot,
  randomWholeDollars,
  runTag,
  suspenseAccountId,
  totalsSnapshot,
  type ExpenseAccount,
  type Persona,
  type PnlSnapshot,
  type Totals,
} from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * PR 1 — one-step categorisation, proved on a DEPLOYED site for each market.
 *
 * What this proves (and the unit tests cannot): the category rides WITH the expense on every entry surface —
 * the API, the desktop New Expense form and mobile Capture — the books land on that category and never on the
 * 6999 suspense account, a human's choice is remembered so the next entry is prefilled, and a bad category is
 * refused. Every record carries the persona's run tag; the last test proves the books are back where they started.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';

for (const persona of ['maya', 'alex', 'sydney'] as Exclude<Persona, 'fresh'>[]) {
  test.describe(`one-step entry - ${persona}`, () => {
    const currency = PERSONA_CURRENCY[persona];
    const tag = runTag(`E2EONE${persona.slice(0, 2).toUpperCase()}`);
    const vendor = `${tag} Vendor`;
    const created: string[] = [];
    let context: BrowserContext;
    let page: Page;
    let t: CatalogT;
    let locale = 'en-US';
    let category: ExpenseAccount;
    let baseline: Totals;

    const idsByQuery = async (q: string): Promise<string[]> => {
      const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(q)}&limit=100`);
      expectOk(res, `list q=${q}`);
      return (res.data.data as Array<{ id: string }>).map((r) => r.id);
    };
    const track = async () => {
      for (const id of await idsByQuery(tag)) if (!created.includes(id)) created.push(id);
    };
    const suggest = async (v: string) => {
      const res = await api(page).get(`${EXPENSE}/categories/suggest?vendor=${encodeURIComponent(v)}`);
      expectOk(res, 'suggest');
      return res.data.data as { categoryId: string; categoryName: string; source: string } | null;
    };
    async function deleteVendorsQuietly() {
      try {
        const res = await api(page).get(`${EXPENSE}/vendors?limit=200`);
        const rows = ((res.data?.data ?? []) as Array<{ id: string; name: string }>).filter((v) => v.name?.includes(tag));
        for (const v of rows) await api(page).delete(`${EXPENSE}/vendors/${v.id}`).catch(() => undefined);
      } catch {
        /* best effort */
      }
    }
    /** The journal movement of a booked expense: only the chosen category moved, suspense did not. */
    async function expectBookedOnCategory(before: PnlSnapshot, cents: number) {
      const after = await pnlSnapshot(page);
      expect(movedAccounts(before, after), 'only the chosen category moved').toEqual({ [category.id]: cents });
      const susp = suspenseAccountId(after);
      if (susp) expect(movedAccounts(before, after)[susp] ?? 0, 'nothing went to suspense').toBe(0);
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const baseURL = testInfo.project.use.baseURL;
      const reason = loginUnavailableReason(baseURL);
      test.skip(reason !== null, reason ?? '');
      context = await newPersonaContext(browser, baseURL);
      page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app/capture');
      await settle(page);
      const loc = await pageLocales(page);
      t = catalogT(loc.stringLocale);
      locale = loc.formatLocale;
      const cats = await listCategoryAccounts(page);
      expect(cats.length, 'persona has expense categories').toBeGreaterThan(0);
      category = cats[0];
      baseline = await totalsSnapshot(page);
    });

    test.afterAll(async () => {
      if (!page) return;
      try {
        await track();
      } catch {
        /* sweep what is tracked */
      }
      for (const id of created) await deleteExpenseQuietly(page, id);
      await deleteVendorsQuietly();
      await context.close();
    });

    test('API: one request books on the chosen category (never suspense) and creates exactly one expense', async () => {
      const dollars = randomWholeDollars();
      const before = await pnlSnapshot(page);
      const res = await api(page).post(`${EXPENSE}/expenses`, {
        amountCents: dollars * 100, vendor, description: `${tag} api`, currency,
        categoryId: category.id, categorySource: 'user',
      });
      expectOk(res, 'create categorised expense');
      await track();
      expect(await idsByQuery(vendor)).toHaveLength(1);
      const one = await getExpense(page, res.data.data.id);
      expect(one.data.data.categoryId).toBe(category.id);
      expect(one.data.data.amountCents).toBe(dollars * 100);
      await expectBookedOnCategory(before, dollars * 100);
    });

    test('the choice is remembered: the next suggestion for this vendor is that category', async () => {
      expect(await suggest(vendor)).toMatchObject({ categoryId: category.id, source: 'vendor' });
      // spelling and case do not matter, another vendor does not inherit it
      expect((await suggest(vendor.toLowerCase()))?.categoryId).toBe(category.id);
      expect(await suggest(`${tag} Someone Else Entirely`)).not.toMatchObject({ categoryId: category.id, source: 'vendor' });
    });

    test('a category that is not the tenant’s expense account is refused and nothing is created', async () => {
      const before = (await idsByQuery(tag)).length;
      const res = await api(page).post(`${EXPENSE}/expenses`, {
        amountCents: 10_000, vendor: `${tag} Bad`, currency, categoryId: '00000000-0000-4000-8000-000000000000', categorySource: 'user',
      });
      expect(res.status).toBe(400);
      expect(res.data).toMatchObject({ success: false, code: 'invalid_category' });
      expect((await idsByQuery(tag)).length).toBe(before);
    });

    test('desktop New Expense: category is prefilled for the remembered vendor and ONE Save books it', async () => {
      test.setTimeout(150_000);
      const dollars = randomWholeDollars();
      const before = await pnlSnapshot(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      try {
        await page.goto('/agentbook/expenses/new');
        await settle(page);
        const dt = catalogT((await pageLocales(page)).stringLocale);
        const select = page.getByLabel(dt('expenses_ui.category_label'), { exact: true });
        await expect(select).toBeVisible();
        await expect.poll(async () => select.locator('option').count()).toBeGreaterThan(1);
        await page.locator('#new-expense-vendor').fill(vendor);
        await expect(select).toHaveValue(category.id); // prefilled from memory, not chosen by the test
        await page.locator('#new-expense-amount').fill(dollars.toFixed(2));
        await page.getByRole('button', { name: dt('expenses_ui.record_expense'), exact: true }).click();
        await expect(page.getByText(dt('expenses_ui.expense_recorded_ok'))).toBeVisible();
        await track();
        const ids = await idsByQuery(vendor);
        expect(ids.length, 'the earlier API expense plus exactly one new one').toBe(2);
        await expectBookedOnCategory(before, dollars * 100);
      } finally {
        await page.setViewportSize({ width: 390, height: 844 });
      }
    });

    test('mobile Capture: manual entry prefills the remembered category and Save books it in one call', async () => {
      test.setTimeout(150_000);
      const dollars = randomWholeDollars();
      const before = await pnlSnapshot(page);
      await page.goto('/app/capture');
      await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
      await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
      await page.getByLabel(t('mobile.capture.field_amount'), { exact: true }).fill(amountInputText(dollars, locale));
      await page.getByLabel(t('mobile.capture.field_vendor'), { exact: true }).fill(vendor);
      const group = page.getByRole('group', { name: t('mobile.capture.category_label') });
      await expect(group.getByRole('button', { name: category.name })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
      await expect(page.getByRole('button', { name: t('mobile.capture.snap') })).toBeVisible();
      await expect.poll(async () => (await idsByQuery(vendor)).length, { timeout: 20_000 }).toBe(3);
      await track();
      await expectBookedOnCategory(before, dollars * 100);
    });

    test("totals invariant: after cleanup the persona's books are exactly where they started", async () => {
      test.setTimeout(180_000);
      await track();
      for (const id of created) await deleteExpenseQuietly(page, id);
      for (const id of created) expect((await getExpense(page, id)).status, `${id} is gone`).toBe(404);
      expect(await idsByQuery(tag), 'nothing of this run is left').toHaveLength(0);
      await deleteVendorsQuietly();
      expect(diffTotals(baseline, await totalsSnapshot(page)), 'fields that did not return to their start').toEqual([]);
      expect(await countByQuery(page, tag)).toBe(0);
    });
  });
}
