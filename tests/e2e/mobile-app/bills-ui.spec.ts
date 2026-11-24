import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, expectScreen, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import { addDaysIso, amountInputText, runTag, todayIso, type Persona } from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * PR 3d — bills are usable from every surface, proved on a DEPLOYED site for alex (US), maya (CA), sydney (AU).
 *
 * Per persona, three tagged bills, each created and unwound by the test (seeded data is never touched; tenant
 * config is only read):
 *   1. WEB Bills page (/agentbook/expenses/bills): Add bill through the form → row shows → "Pay part" half through
 *      the UI → status partial, still owing = the other half → Pay the rest through the UI → paid; AP (2000) is back
 *      at baseline and NO expense row was created for the tag → void both payments and the bill through the UI.
 *   2. MOBILE Capture (/app/capture): manual entry with "Pay later" + a due date → a bill (never an expense) with
 *      that vendor, amount and due date → paid and unwound through the API.
 *   3. CHAT (agent/message, channel web): "Add a bill from <tag> $X due <date>" → record-bill created exactly that
 *      bill; "What bills are due?" → query-payables; "Pay the <tag> bill" → pay-bill paid it in full, no expense.
 * Final: trial-balance 2000 and 1000 are back at baseline (every payment voided, every bill voided) and it balances.
 * Catalog locale is read only after an /app page loaded and proven against its h1 (Maya renders French).
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';
const CHAT = `${CORE}/agent/message`;

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface Bill { id: string; vendorName: string; amountCents: number; paidCents: number; status: string; dueDate: string }
interface Ctx { context: BrowserContext; page: Page; t: CatalogT; formatLocale: string }

async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true, byCode };
}
const delta = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);

async function billsTagged(page: Page, tag: string): Promise<Bill[]> {
  const res = await api(page).get(`${EXPENSE}/bills?status=all`);
  expectOk(res, 'list bills');
  return (res.data.data as Bill[]).filter((b) => b.vendorName.toUpperCase().includes(tag));
}
async function expensesTagged(page: Page, tag: string): Promise<number> {
  const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(tag)}&limit=100`);
  expectOk(res, 'list expenses');
  return (res.data.data as unknown[]).length;
}
/** Void every live payment, then the bill (the only order the engine allows). */
async function unwindBill(page: Page, id: string): Promise<void> {
  const got = await api(page).get(`${EXPENSE}/bills/${id}`);
  if (got.status !== 200) return;
  for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
    await api(page).delete(`${EXPENSE}/bills/${id}/payments/${p.id}`);
  }
  if (got.data.data.status !== 'cancelled') await api(page).delete(`${EXPENSE}/bills/${id}`);
}

for (const persona of ['alex', 'maya', 'sydney'] as Persona[]) {
  test.describe(`bills surfaces — ${persona}`, () => {
    let ctx: Ctx | undefined;
    const tag = runTag(`E2EBIL${persona.slice(0, 2).toUpperCase()}`);
    let baseline: Tb;

    test.beforeAll(async ({ browser }, testInfo) => {
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      test.skip(reason !== null, reason ?? '');
      const context = await newPersonaContext(browser, testInfo.project.use.baseURL);
      const page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app');
      await settle(page);
      const loc = await pageLocales(page);
      const t = catalogT(loc.stringLocale);
      await expectScreen(page, '/app', t);
      page.on('dialog', (d) => { void d.accept(); });
      ctx = { context, page, t, formatLocale: loc.formatLocale };
      baseline = await trialBalance(page);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      try {
        for (const b of await billsTagged(ctx.page, tag)) await unwindBill(ctx.page, b.id);
      } catch (err) {
        console.error(`[bills-ui e2e] afterAll unwind failed for ${persona}:`, err);
      }
      await ctx.context.close().catch(() => {});
    });

    test('web Bills page: add → pay part → pay rest → void payments → void bill', async () => {
      const { page, t, formatLocale } = ctx!;
      const vendor = `${tag} WEB`;
      const dollars = 120 + Math.floor(Math.random() * 50) * 2; // even → exact halves
      await page.goto('/agentbook/expenses/bills');
      await page.getByRole('button', { name: t('expenses_ui.add_bill') }).click();
      const form = page.getByRole('form', { name: t('expenses_ui.add_bill') });
      await form.getByLabel(t('expenses_ui.col_vendor')).fill(vendor);
      await form.getByLabel(t('expenses_ui.col_amount')).fill(amountInputText(dollars, formatLocale));
      await form.getByLabel(t('expenses_ui.bill_date')).fill(todayIso());
      await form.getByLabel(t('expenses_ui.bill_due_date')).fill(addDaysIso(todayIso(), 21));
      await form.getByRole('button', { name: t('expenses_ui.save_bill') }).click();
      await expect.poll(async () => (await billsTagged(page, tag)).length, { timeout: 20_000 }).toBe(1);
      const [bill] = await billsTagged(page, tag);
      expect([bill.vendorName, bill.amountCents, bill.dueDate.slice(0, 10)]).toEqual([vendor, dollars * 100, addDaysIso(todayIso(), 21)]);

      const row = page.getByTestId(`bill-row-${bill.id}`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole('button', { name: t('expenses_ui.bill_pay_partial') }).click();
      await page.getByRole('textbox').last().fill(amountInputText(dollars / 2, formatLocale));
      await page.getByRole('button', { name: t('expenses_ui.bill_record_payment') }).click();
      await expect.poll(async () => (await billsTagged(page, tag))[0].paidCents, { timeout: 20_000 }).toBe((dollars / 2) * 100);
      expect((await billsTagged(page, tag))[0].status).toBe('partial');

      await page.getByTestId(`bill-row-${bill.id}`).getByRole('button', { name: t('expenses_ui.pay'), exact: true }).click();
      await expect.poll(async () => (await billsTagged(page, tag))[0].status, { timeout: 20_000 }).toBe('paid');
      const paid = await trialBalance(page);
      expect(delta(baseline, paid, '2000'), 'AP back at baseline once paid').toBe(0);
      expect(delta(baseline, paid, '1000'), 'cash down by the bill').toBe(-dollars * 100);
      expect(await expensesTagged(page, tag), 'paying a bill never creates an expense').toBe(0);

      // Unwind through the UI: void each payment, then the bill.
      await page.reload();
      await page.getByRole('button', { name: t('expenses_ui.bill_show_payments', { vendor }) }).click();
      for (let i = 0; i < 2; i++) {
        await page.getByRole('button', { name: t('expenses_ui.bill_void_payment') }).first().click();
        await expect.poll(async () => (await billsTagged(page, tag))[0].paidCents, { timeout: 20_000 }).toBe(i === 0 ? (dollars / 2) * 100 : 0);
      }
      await page.getByTestId(`bill-row-${bill.id}`).getByRole('button', { name: t('expenses_ui.bill_void') }).click();
      await expect.poll(async () => (await billsTagged(page, tag))[0].status, { timeout: 20_000 }).toBe('cancelled');
      const after = await trialBalance(page);
      for (const code of ['2000', '1000']) expect(delta(baseline, after, code), `${code} back to baseline`).toBe(0);
      expect(after.balanced).toBe(true);
    });

    test('mobile Capture "Pay later" creates a bill, not an expense', async () => {
      const { page, t, formatLocale } = ctx!;
      const vendor = `${tag} CAP`;
      const dollars = 61;
      const due = addDaysIso(todayIso(), 10);
      await page.goto('/app/capture');
      await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
      await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
      await page.getByLabel(t('mobile.capture.field_amount'), { exact: true }).fill(amountInputText(dollars, formatLocale));
      await page.getByLabel(t('mobile.capture.field_vendor'), { exact: true }).fill(vendor);
      await page.getByRole('switch', { name: t('mobile.capture.pay_later') }).click();
      await page.getByLabel(t('mobile.capture.field_due_date'), { exact: true }).fill(due);
      await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
      await expect(page.getByText(t('mobile.capture.bill_saved'))).toBeVisible({ timeout: 20_000 });
      const bills = (await billsTagged(page, tag)).filter((b) => b.vendorName === vendor);
      expect(bills.map((b) => [b.amountCents, b.dueDate.slice(0, 10), b.status])).toEqual([[dollars * 100, due, 'open']]);
      expect(await expensesTagged(page, vendor)).toBe(0);
      expectOk(await api(page).post(`${EXPENSE}/bills/${bills[0].id}?action=pay`, {}), 'pay capture bill');
      await unwindBill(page, bills[0].id);
    });

    test('chat: record-bill, pay-bill, query-payables', async () => {
      const { page } = ctx!;
      const vendor = `${tag}CHAT`;
      const due = addDaysIso(todayIso(), 15);
      const say = async (text: string) => {
        const res = await api(page).post(CHAT, { channel: 'web', text });
        expect(res.status, `chat: ${text}`).toBe(200);
        return res.data.data as { message: string; skillUsed?: string };
      };
      const rec = await say(`Add a bill from ${vendor} $43.21 due ${due}`);
      expect(rec.skillUsed).toBe('record-bill');
      const created = (await billsTagged(page, vendor)).filter((b) => b.status !== 'cancelled');
      expect(created.map((b) => [b.vendorName.toUpperCase(), b.amountCents, b.dueDate.slice(0, 10)])).toEqual([[vendor, 4321, due]]);

      const listed = await say('What bills are due?');
      // The reply lists the earliest 8 open bills; a persona may hold more, so only the skill is asserted here.
      expect(listed.skillUsed).toBe('query-payables');

      const paid = await say(`Pay the ${vendor} bill`);
      expect(paid.skillUsed).toBe('pay-bill');
      await expect.poll(async () => (await billsTagged(page, vendor))[0].status, { timeout: 20_000 }).toBe('paid');
      expect(await expensesTagged(page, vendor), 'pay-bill on an open bill never books an expense').toBe(0);
      await unwindBill(page, created[0].id);

      const end = await trialBalance(page);
      for (const code of ['2000', '1000']) expect(delta(baseline, end, code), `${code} back to baseline`).toBe(0);
      expect(end.balanced).toBe(true);
    });
  });
}
