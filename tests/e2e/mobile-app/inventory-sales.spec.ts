import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, expectScreen, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import { addDaysIso, runTag, todayIso, type Persona } from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * PR 5B — inventory sales and COGS, proved on a DEPLOYED site for alex (US), maya (CA), sydney (AU).
 *
 * Per persona, every fixture tagged and unwound by the test (no ledger residue on the persona):
 *   tagged item → tagged bill for 10 units, paid (stock in: 1500 +amount; the 5A path, fully voidable — opening
 *   stock is NOT used because its 3900 side has no reversing route) → tagged client → invoice with an item line
 *   for 4 units (revenue AND COGS post at creation, draft) → assert 1500 −4×avg, COGS (+5990 US/CA, +5000 AU)
 *   +4×avg, item qty 6 → COGS-by-period lists today's month → VOID the invoice (stock_sale_void) → 1500/COGS/
 *   revenue/AR/tax back to the post-purchase values, qty 10 → void the payment and the bill → soft-delete the
 *   invoice, client and item. Final: every touched account is back to baseline and the trial balance balances.
 *
 * Precondition (read only, never toggled): trackInventory is ON for alex, maya and sydney.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const INVOICE = '/api/v1/agentbook-invoice';
const INV = `${EXPENSE}/inventory`;
const CORE = '/api/v1/agentbook-core';
const ENABLE = 'sign in as the persona and PUT /api/v1/agentbook-core/tenant-config {"trackInventory":true}';
const COGS_CODE: Record<Persona, string> = { alex: '5990', maya: '5990', sydney: '5000' } as Record<Persona, string>;

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface Ctx { context: BrowserContext; page: Page; t: CatalogT }

async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true, byCode };
}
const delta = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);
const codesOf = (...tbs: Tb[]) => [...new Set(tbs.flatMap((t) => Object.keys(t.byCode)))];

for (const persona of ['alex', 'maya', 'sydney'] as Persona[]) {
  test.describe(`inventory sales — ${persona}`, () => {
    let ctx: Ctx | undefined;
    const tag = runTag(`E2ECOGS${persona.slice(0, 2).toUpperCase()}`);
    let itemId: string | null = null;
    let billId: string | null = null;
    let clientId: string | null = null;
    let invoiceId: string | null = null;
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
      ctx = { context, page, t };
      const cfg = await api(page).get(`${CORE}/tenant-config`);
      expectOk(cfg, 'tenant config');
      expect(cfg.data.data.trackInventory, `${persona} must track inventory (precondition). Enable it: ${ENABLE}`).toBe(true);
      baseline = await trialBalance(page);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      const page = ctx.page;
      try {
        if (invoiceId) {
          const got = await api(page).get(`${INVOICE}/invoices/${invoiceId}`);
          if (got.status === 200 && got.data.data.status !== 'void') await api(page).post(`${INVOICE}/invoices/${invoiceId}/void`, {});
          await api(page).delete(`${INVOICE}/invoices/${invoiceId}`);
        }
        if (billId) {
          const got = await api(page).get(`${EXPENSE}/bills/${billId}`);
          if (got.status === 200) {
            for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
              await api(page).delete(`${EXPENSE}/bills/${billId}/payments/${p.id}`);
            }
            if (got.data.data.status !== 'cancelled') await api(page).delete(`${EXPENSE}/bills/${billId}`);
          }
        }
        if (clientId) await api(page).delete(`${INVOICE}/clients/${clientId}`);
        if (itemId) await api(page).delete(`${INV}/items/${itemId}`);
      } catch (err) {
        console.error(`[inventory-sales e2e] afterAll unwind failed for ${persona}:`, err);
      }
      await ctx.context.close().catch(() => {});
    });

    test('invoice item line relieves stock to COGS at average cost; void restores; unwind to baseline', async () => {
      const page = ctx!.page;
      const cogsCode = COGS_CODE[persona];
      const amount = 5000 + Math.floor(Math.random() * 40) * 10; // divisible by 10 → exact avg cost
      const avg = amount / 10;

      const created = await api(page).post(`${INV}/items`, { name: `${tag} widget`, sku: tag, unit: 'each' });
      expectOk(created, 'create item');
      itemId = created.data.data.id;
      const bill = await api(page).post(`${EXPENSE}/bills`, {
        vendorName: `${tag} supplier`, description: `${tag} 10 widgets`, amountCents: amount,
        dueDate: addDaysIso(todayIso(), 30), billDate: todayIso(), itemId, qty: 10, taxCode: null,
      });
      expectOk(bill, 'create item bill');
      billId = bill.data.data.id;
      expectOk(await api(page).post(`${EXPENSE}/bills/${billId}?action=pay`, {}), 'pay item bill');
      const stocked = await trialBalance(page);
      expect(delta(baseline, stocked, '1500'), '1500 rose by the bill').toBe(amount);

      const client = await api(page).post(`${INVOICE}/clients`, { name: `${tag} customer` });
      expectOk(client, 'create client');
      clientId = client.data.data.id;
      const inv = await api(page).post(`${INVOICE}/invoices`, {
        clientId, issuedDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), status: 'draft',
        lines: [{ description: `${tag} widgets`, quantity: 4, rateCents: 2000, itemId }],
      });
      expectOk(inv, 'create invoice with an item line');
      invoiceId = inv.data.data.id;

      const sold = await trialBalance(page);
      expect(delta(stocked, sold, '1500'), '1500 relieved at 4 × average cost').toBe(0 - 4 * avg);
      expect(delta(stocked, sold, cogsCode), `COGS ${cogsCode} = 4 × average cost`).toBe(4 * avg);
      expect(delta(stocked, sold, '4000'), 'revenue for the line').toBe(0 - 8000);
      expect(sold.balanced).toBe(true);
      const item = await api(page).get(`${INV}/items/${itemId}`);
      expect(item.data.data.onHandQty).toBe(6);
      expect(item.data.data.onHandValueCents).toBe(amount - 4 * avg);

      const month = todayIso().slice(0, 7);
      const cogs = await api(page).get(`${INV}/cogs?granularity=month&from=${month}-01`);
      expectOk(cogs, 'COGS by period');
      const row = (cogs.data.data.periods as Array<{ period: string; cogsCents: number }>).find((p) => p.period === month);
      expect(row?.cogsCents ?? 0, 'this month includes the sale').toBeGreaterThanOrEqual(4 * avg);

      // Desktop Items page shows the COGS-by-quarter section.
      await page.goto('/agentbook/expenses/items');
      await expect(page.getByTestId('cogs-by-period')).toBeVisible({ timeout: 20_000 });

      expectOk(await api(page).post(`${INVOICE}/invoices/${invoiceId}/void`, {}), 'void invoice');
      const voided = await trialBalance(page);
      for (const code of codesOf(stocked, voided)) {
        expect(delta(stocked, voided, code), `void restores ${code}`).toBe(0);
      }
      const back = await api(page).get(`${INV}/items/${itemId}`);
      expect(back.data.data.onHandQty, 'stock restored').toBe(10);
      expect(back.data.data.onHandValueCents, 'value restored').toBe(amount);

      // Unwind the purchase, then soft-delete the fixtures.
      const got = await api(page).get(`${EXPENSE}/bills/${billId}`);
      for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
        expectOk(await api(page).delete(`${EXPENSE}/bills/${billId}/payments/${p.id}`), 'void payment');
      }
      expectOk(await api(page).delete(`${EXPENSE}/bills/${billId}`), 'void bill');
      billId = null;
      expectOk(await api(page).delete(`${INVOICE}/invoices/${invoiceId}`), 'soft-delete invoice');
      invoiceId = null;
      expectOk(await api(page).delete(`${INVOICE}/clients/${clientId}`), 'soft-delete client');
      clientId = null;
      expectOk(await api(page).delete(`${INV}/items/${itemId}`), 'soft-delete item');
      itemId = null;

      const end = await trialBalance(page);
      for (const code of codesOf(baseline, end)) {
        expect(delta(baseline, end, code), `account ${code} back to baseline`).toBe(0);
      }
      expect(end.balanced, 'trial balance balances').toBe(true);
    });
  });
}
