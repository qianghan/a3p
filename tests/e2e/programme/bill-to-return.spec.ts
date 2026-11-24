import { test, expect } from '@playwright/test';
import { addDaysIso, amountInputText, listCategoryAccounts, runTag, todayIso, type ExpenseAccount } from '../mobile-app/fixtures';
import { api, expectOk } from '../nightly/helpers/api';
import { computeLineTax, defaultTaxCode } from '../../../packages/agentbook-jurisdictions/src/tax-codes';
import {
  EXPENSE, PERSONAS, expenseIdsByQuery, linesDelta, openPersona, returnLines, say, tbDelta, tbMoved, trialBalance, unwindBill,
  type Ctx, type ReturnLines, type Tb,
} from './lib';

/**
 * J-bill-to-return (R-AP-1, R-AP-2, R-AP-6, R-AP-7, R-TAX-4) — an unpaid, tax-typed bill from entry to the sales-tax
 * return, across PR 2b (tax codes), 3bc (AP at entry) and 3d (bills surfaces), on a DEPLOYED site for maya, alex,
 * sydney. Requires purchases_at_entry ON for the persona: a new bill that is not `at_entry` FAILS naming the command.
 *
 * Per persona, two tagged bills (A, B) with the market's default tax code, created and unwound by the test:
 *   A: on the books at entry — 2000 −gross, category +net, 2100 +recoverable (the engine's), cash 0, no expense row;
 *      web Bills page "Pay part" (half) → AP/cash move by half; an overpayment is refused and moves nothing; two
 *      CONCURRENT payments of the remainder → exactly one succeeds, paid = gross, never more.
 *   B: paid in full by CHAT ("Pay the <vendor> bill" → pay-bill), no expense row.
 *   Purchases list (the Docs/Expenses source): each bill exactly once, badge paid, never an expense row.
 *   Return: AU BAS 1B/G11 (accrual by bill date; cash GST by payment = the same once fully paid) / CA line 108 ITC
 *   moved by exactly A+B recoverable / gross; US has no return and recoverable 0.
 *   Unwind (payments voided, bills voided): every trial-balance code and return line back at baseline.
 */
// Serial per persona (not per file): one persona with the flag off must not stop the other two from running.
const ENABLE = 'npx tsx agentbook/enable-purchases-at-entry.ts --apply';
interface Bill { id: string; status: string; postingMode: string; amountCents: number; paidCents: number; recoverableTaxCents: number | null; taxCode: string | null; vendorName: string }

for (const persona of PERSONAS) {
  test.describe(`bill to return journey — ${persona}`, () => {
    test.describe.configure({ mode: 'serial' });
    let ctx: Ctx;
    const tag = runTag(`E2EJBIL${persona.slice(0, 2).toUpperCase()}`);
    const created: string[] = [];
    let cat: ExpenseAccount;
    let code: string | null = null;
    let tb0: Tb;
    let rl0: ReturnLines;
    const bills: Record<'a' | 'b', Bill | null> = { a: null, b: null };

    const engineRec = (gross: number) => (!code || ctx.cfg.gstRegistered !== true) ? 0 : computeLineTax({
      jurisdiction: ctx.cfg.jurisdiction as 'ca' | 'au', region: ctx.cfg.region, taxCode: code, amountCents: gross, inclusive: true,
      registration: { gstRegistered: true, qstRegistered: ctx.cfg.qstRegistered },
    }).recoverableTaxCents;
    const getBill = async (id: string) => (await api(ctx.page).get(`${EXPENSE}/bills/${id}`)).data.data as Bill;

    async function createAtEntry(key: 'a' | 'b', gross: number): Promise<Bill> {
      const page = ctx.page;
      const tb = await trialBalance(page);
      const res = await api(page).post(`${EXPENSE}/bills`, {
        vendorName: `${tag}${key.toUpperCase()} Supplies`, description: `${tag} bill ${key}`, amountCents: gross, categoryCode: cat.code,
        billDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), idempotencyKey: `${tag}-${key}`,
        ...(code ? { taxCode: code, taxInclusive: true } : {}),
      });
      expectOk(res, `create bill ${key}`);
      const bill = res.data.data as Bill;
      created.push(bill.id);
      bills[key] = bill;
      expect(bill.postingMode, `${persona}'s new bill must post at entry (purchases_at_entry is OFF for this tenant). Enable it: ${ENABLE}`).toBe('at_entry');
      const rec = engineRec(gross);
      expect(bill.recoverableTaxCents ?? 0, 'bill recoverable = the engine').toBe(rec);
      if (persona !== 'alex') expect(rec, 'a registrant recovers tax on the bill').toBeGreaterThan(0);
      const tb1 = await trialBalance(page);
      expect({ ap: tbDelta(tb, tb1, '2000'), cat: tbDelta(tb, tb1, cat.code), tax: tbDelta(tb, tb1, '2100'), cash: tbDelta(tb, tb1, '1000') },
        'on the books on its bill date').toEqual({ ap: 0 - gross, cat: gross - rec, tax: rec, cash: 0 });
      expect(tb1.balanced).toBe(true);
      return bill;
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
      expect(ctx.cfg.accountingBasis ?? 'accrual', `${persona} is an accrual tenant`).not.toBe('cash');
      cat = (await listCategoryAccounts(ctx.page)).filter((c) => !/meal|entertain/i.test(c.name))[0];
      expect(cat, 'a non-meals expense category').toBeTruthy();
      code = persona === 'alex' ? null : defaultTaxCode(ctx.cfg.jurisdiction as 'ca' | 'au', ctx.cfg.region);
      tb0 = await trialBalance(ctx.page);
      rl0 = await returnLines(ctx.page, ctx.cfg.jurisdiction);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      for (const id of created) await unwindBill(ctx.page, id);
      await ctx.context.close().catch(() => undefined);
    });

    test('bill A: AP at entry; web "Pay part"; overpayment refused; concurrent payments cannot overpay', async () => {
      test.setTimeout(200_000);
      const { page, t, formatLocale } = ctx;
      const dollars = 226 + 2 * Math.floor(Math.random() * 30); // even → exact half
      const gross = dollars * 100;
      const half = gross / 2;
      const a = await createAtEntry('a', gross);

      await page.goto('/agentbook/expenses/bills');
      const row = page.getByTestId(`bill-row-${a.id}`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      const tb1 = await trialBalance(page);
      await row.getByRole('button', { name: t('expenses_ui.bill_pay_partial') }).click();
      await page.getByRole('textbox').last().fill(amountInputText(half / 100, formatLocale));
      await page.getByRole('button', { name: t('expenses_ui.bill_record_payment') }).click();
      await expect.poll(async () => (await getBill(a.id)).paidCents, { timeout: 20_000 }).toBe(half);
      expect((await getBill(a.id)).status).toBe('partial');
      const tb2 = await trialBalance(page);
      expect({ ap: tbDelta(tb1, tb2, '2000'), cash: tbDelta(tb1, tb2, '1000'), cat: tbDelta(tb1, tb2, cat.code), tax: tbDelta(tb1, tb2, '2100') },
        'part payment moves AP to cash only').toEqual({ ap: half, cash: 0 - half, cat: 0, tax: 0 });

      const over = await api(page).post(`${EXPENSE}/bills/${a.id}?action=pay`, { amountCents: gross - half + 1 });
      expect(over.status, 'overpayment refused').toBeGreaterThanOrEqual(400);
      expect(over.status).toBeLessThan(500);
      expect(tbMoved(tb2, await trialBalance(page)), 'a refused overpayment moves nothing').toEqual({});

      const rest = gross - half;
      const both = await Promise.all([0, 1].map(() => api(page).post(`${EXPENSE}/bills/${a.id}?action=pay`, { amountCents: rest })));
      const ok = both.filter((r) => r.status >= 200 && r.status < 300);
      expect(ok.length, `exactly one of two concurrent payments of the remainder succeeds (got ${both.map((r) => r.status)})`).toBe(1);
      const paid = await getBill(a.id);
      expect([paid.status, paid.paidCents], 'paid in full, never more').toEqual(['paid', gross]);
      const tb3 = await trialBalance(page);
      expect({ ap: tbDelta(tb2, tb3, '2000'), cash: tbDelta(tb2, tb3, '1000'), cat: tbDelta(tb2, tb3, cat.code) }).toEqual({ ap: rest, cash: 0 - rest, cat: 0 });
      expect(await expenseIdsByQuery(page, tag), 'paying a bill never creates an expense').toEqual([]);
    });

    test('bill B: paid in full by chat (pay-bill), no expense row', async () => {
      const page = ctx.page;
      const gross = 11300;
      const b = await createAtEntry('b', gross);
      const tb1 = await trialBalance(page);
      const reply = await say(page, `Pay the ${b.vendorName} bill`);
      expect(reply.skillUsed).toBe('pay-bill');
      await expect.poll(async () => (await getBill(b.id)).status, { timeout: 20_000 }).toBe('paid');
      const tb2 = await trialBalance(page);
      expect({ ap: tbDelta(tb1, tb2, '2000'), cash: tbDelta(tb1, tb2, '1000'), cat: tbDelta(tb1, tb2, cat.code) }).toEqual({ ap: gross, cash: 0 - gross, cat: 0 });
      expect(await expenseIdsByQuery(page, tag)).toEqual([]);
    });

    test('purchases list: each bill once, badge paid; the return moved by exactly the recoverable on line data', async () => {
      const page = ctx.page;
      const res = await api(page).get(`${EXPENSE}/purchases?kind=bill&limit=200`);
      expectOk(res, 'purchases');
      const mine = (res.data.data as Array<{ kind: string; id: string; status: string; amountCents: number }>)
        .filter((r) => r.id === bills.a!.id || r.id === bills.b!.id)
        .map((r) => [r.id, r.kind, r.status, r.amountCents]).sort();
      expect(mine).toEqual([[bills.a!.id, 'bill', 'paid', bills.a!.amountCents], [bills.b!.id, 'bill', 'paid', bills.b!.amountCents]].sort());
      const rec = engineRec(bills.a!.amountCents) + engineRec(bills.b!.amountCents);
      const gross = bills.a!.amountCents + bills.b!.amountCents;
      const d = linesDelta(rl0, await returnLines(page, ctx.cfg.jurisdiction));
      if (ctx.cfg.jurisdiction === 'au') expect([d.b1, d.g11], 'BAS 1B / G11 from the bill lines').toEqual([rec, gross]);
      if (ctx.cfg.jurisdiction === 'ca') expect(d.itc, 'GST/HST line 108 ITC from the bill lines').toBe(rec);
      if (ctx.cfg.jurisdiction === 'us') expect(rec).toBe(0);
    });

    test('unwind: payments and bills voided; every code and return line back at baseline', async () => {
      const page = ctx.page;
      for (const id of created) await unwindBill(page, id);
      for (const id of created) expect((await getBill(id)).status, `${id} voided`).toBe('cancelled');
      expect(tbMoved(tb0, await trialBalance(page)), 'codes not back at baseline').toEqual({});
      expect(linesDelta(rl0, await returnLines(page, ctx.cfg.jurisdiction))).toEqual({ b1: 0, g10: 0, g11: 0, w1: 0, w2: 0, itc: 0 });
    });
  });
}
