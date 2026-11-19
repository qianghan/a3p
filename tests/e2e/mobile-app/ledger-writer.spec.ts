import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, loginUnavailableReason, newPersonaContext, settle } from './helpers';
import {
  PERSONA_CURRENCY,
  deleteExpenseQuietly,
  diffTotals,
  getExpense,
  listCategoryAccounts,
  movedAccounts,
  pnlSnapshot,
  randomWholeDollars,
  runTag,
  totalsSnapshot,
  type ExpenseAccount,
  type Persona,
  type PnlSnapshot,
  type Totals,
} from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * PR 2a — ledger writer extraction, proved on a DEPLOYED site for each market.
 *
 * The refactor must not change production behaviour: an untyped expense's create, amount edit, category
 * change and delete each move the P&L by exactly the expected cents, and the books return to baseline.
 * One tagged fixture per persona, dated today, created and deleted by this test; never seeded data.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';

for (const persona of ['maya', 'alex', 'sydney'] as Exclude<Persona, 'fresh'>[]) {
  test.describe(`ledger writer - ${persona}`, () => {
    const currency = PERSONA_CURRENCY[persona];
    const tag = runTag(`E2ELW${persona.slice(0, 2).toUpperCase()}`);
    let context: BrowserContext;
    let page: Page;
    let first: ExpenseAccount;
    let second: ExpenseAccount;
    let baseline: Totals;
    let expenseId: string | null = null;
    let cents = 0;

    async function expectMoved(before: PnlSnapshot, expected: Record<string, number>) {
      const after = await pnlSnapshot(page);
      expect(movedAccounts(before, after), 'P&L movement by account').toEqual(expected);
      const total = Object.values(expected).reduce((s, v) => s + v, 0);
      expect(after.totalExpensesCents - before.totalExpensesCents, 'P&L total expenses moved by').toBe(total);
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const baseURL = testInfo.project.use.baseURL;
      const reason = loginUnavailableReason(baseURL);
      test.skip(reason !== null, reason ?? '');
      context = await newPersonaContext(browser, baseURL);
      page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app');
      await settle(page);
      const cats = await listCategoryAccounts(page);
      expect(cats.length, 'persona has two expense categories').toBeGreaterThan(1);
      [first, second] = cats;
      baseline = await totalsSnapshot(page);
    });

    test.afterAll(async () => {
      if (!page) return;
      if (expenseId) await deleteExpenseQuietly(page, expenseId);
      await context.close();
    });

    test('create with a category books exactly the amount on it', async () => {
      cents = randomWholeDollars() * 100;
      const before = await pnlSnapshot(page);
      const res = await api(page).post(`${EXPENSE}/expenses`, {
        amountCents: cents, vendor: `${tag} Vendor`, description: `${tag} ledger`, currency,
        categoryId: first.id, categorySource: 'user',
      });
      expectOk(res, 'create expense');
      expenseId = res.data.data.id as string;
      await expectMoved(before, { [first.id]: cents });
    });

    test('editing the amount moves the P&L by exactly the difference', async () => {
      const before = await pnlSnapshot(page);
      const next = cents + 1_234;
      expectOk(await api(page).put(`${EXPENSE}/expenses/${expenseId}`, { amountCents: next }), 'edit amount');
      await expectMoved(before, { [first.id]: next - cents });
      cents = next;
    });

    test('changing the category moves the whole amount between accounts, total unchanged', async () => {
      const before = await pnlSnapshot(page);
      expectOk(await api(page).put(`${EXPENSE}/expenses/${expenseId}`, { categoryId: second.id }), 'change category');
      await expectMoved(before, { [first.id]: -cents, [second.id]: cents });
    });

    test('deleting reverses it and the books return to baseline', async () => {
      test.setTimeout(180_000);
      const before = await pnlSnapshot(page);
      expectOk(await api(page).delete(`${EXPENSE}/expenses/${expenseId}`), 'delete expense');
      await expectMoved(before, { [second.id]: -cents });
      expect((await getExpense(page, expenseId as string)).status).toBe(404);
      expenseId = null;
      expect(diffTotals(baseline, await totalsSnapshot(page)), 'fields that did not return to their start').toEqual([]);
    });
  });
}
