import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, expectScreen, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import { addDaysIso, runTag, todayIso, type Persona } from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * PR 5A — inventory items, purchases and on-hand, proved on a DEPLOYED site for alex (US), maya (CA), sydney (AU).
 *
 * Per persona: create a tagged item → record a tagged bill for 10 units → pay it → 1500 Inventory rises by exactly
 * the bill amount, cash falls by it, and the item shows qty 10 / value = amount (avg cost amount ÷ 10) → adjust −1
 * (shrinkage 5995 +avg, 1500 −avg) → adjust +1 at the same value (back) → void the payment and the bill (the stock
 * movement reverses) → soft-delete the item. Final check: every touched account (1000, 1500, 2000, 5995) is back
 * to its baseline and the trial balance balances.
 *
 * WHICH PATH: bills POST picks at_entry only when the tenant has `purchases_at_entry`; on prod that flag is not yet
 * enabled for these personas, so the run goes through the **at_payment** path (stock arrives at payment: DR 1500 |
 * CR 1000). If the flag IS on, the same assertions hold (at entry DR 1500 | CR 2000, at payment DR 2000 | CR 1000):
 * after the payment, 1500 +amount, 1000 −amount, 2000 net 0 in both modes. The spec logs which mode the bill got.
 *
 * Precondition: trackInventory is ON for alex, maya and sydney. The controller enables it once, through the app's own
 * tenant-config API signed in AS each persona (the same way GST registration is set) —
 *   PUT /api/v1/agentbook-core/tenant-config  { "trackInventory": true }
 * The spec itself only READS tenant config: beforeAll fails loudly — never skips, never toggles — when the flag is
 * off, naming that step. Fixtures are tagged, dated today (UTC), created and unwound by the test; seeded data is
 * never touched.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const INV = `${EXPENSE}/inventory`;
const CORE = '/api/v1/agentbook-core';
const ENABLE = 'sign in as the persona and PUT /api/v1/agentbook-core/tenant-config {"trackInventory":true}';
const TOUCHED = ['1000', '1500', '2000', '5995'] as const;

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface Item { id: string; name: string; onHandQty: number; onHandValueCents: number; avgCostCents: number | null }
interface Ctx { context: BrowserContext; page: Page; t: CatalogT }

async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true, byCode };
}
const delta = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);

async function getItem(page: Page, id: string): Promise<Item & { movements: unknown[] }> {
  const res = await api(page).get(`${INV}/items/${id}`);
  expectOk(res, 'get item');
  return res.data.data;
}

for (const persona of ['alex', 'maya', 'sydney'] as Persona[]) {
  test.describe(`inventory — ${persona}`, () => {
    let ctx: Ctx | undefined;
    const tag = runTag(`E2EINV${persona.slice(0, 2).toUpperCase()}`);
    let itemId: string | null = null;
    let billId: string | null = null;
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
      await expectScreen(page, '/app', t); // the catalog locale is trusted only once the page renders in it
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
        if (billId) {
          const got = await api(page).get(`${EXPENSE}/bills/${billId}`);
          if (got.status === 200) {
            for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
              await api(page).delete(`${EXPENSE}/bills/${billId}/payments/${p.id}`);
            }
            if (got.data.data.status !== 'cancelled') await api(page).delete(`${EXPENSE}/bills/${billId}`);
          }
        }
        if (itemId) await api(page).delete(`${INV}/items/${itemId}`);
      } catch (err) {
        console.error(`[inventory e2e] afterAll unwind failed for ${persona}:`, err);
      }
      await ctx.context.close().catch(() => {});
    });

    test('purchase via a bill line → 1500 and on-hand qty/value; adjust; unwind to baseline', async () => {
      const page = ctx!.page;
      const amount = 5000 + Math.floor(Math.random() * 40) * 10; // divisible by 10 → exact avg cost
      const created = await api(page).post(`${INV}/items`, { name: `${tag} widget`, sku: tag, unit: 'each' });
      expectOk(created, 'create item');
      itemId = created.data.data.id;
      const dup = await api(page).post(`${INV}/items`, { name: `${tag} again`, sku: tag });
      expect(dup.status, 'duplicate SKU').toBe(409);

      const bill = await api(page).post(`${EXPENSE}/bills`, {
        vendorName: `${tag} supplier`, description: `${tag} 10 widgets`, amountCents: amount,
        dueDate: addDaysIso(todayIso(), 30), billDate: todayIso(), itemId, qty: 10, taxCode: null,
      });
      expectOk(bill, 'create item bill');
      billId = bill.data.data.id;
      console.log(`[inventory e2e] ${persona}: bill postingMode=${bill.data.data.postingMode}`);

      const pay = await api(page).post(`${EXPENSE}/bills/${billId}?action=pay`, {});
      expectOk(pay, 'pay item bill');
      const afterPay = await trialBalance(page);
      expect(delta(baseline, afterPay, '1500'), '1500 Inventory rose by the bill').toBe(amount);
      expect(delta(baseline, afterPay, '1000'), 'cash fell by the bill').toBe(0 - amount);
      expect(delta(baseline, afterPay, '2000'), 'AP net zero once paid').toBe(0);
      expect(afterPay.balanced).toBe(true);
      let item = await getItem(page, itemId!);
      expect(item.onHandQty).toBe(10);
      expect(item.onHandValueCents).toBe(amount);
      expect(item.avgCostCents).toBe(amount / 10);

      const avg = amount / 10;
      const down = await api(page).post(`${INV}/items/${itemId}/adjust`, { qty: -1, idempotencyKey: `${tag}-down`, reason: tag });
      expectOk(down, 'adjust −1');
      const afterDown = await trialBalance(page);
      expect(delta(afterPay, afterDown, '5995'), 'shrinkage at average cost').toBe(avg);
      expect(delta(afterPay, afterDown, '1500')).toBe(0 - avg);
      const replay = await api(page).post(`${INV}/items/${itemId}/adjust`, { qty: -1, idempotencyKey: `${tag}-down`, reason: tag });
      expect(replay.status, 'replayed adjustment').toBe(200);
      expect(delta(afterPay, await trialBalance(page), '1500'), 'replay posted nothing').toBe(0 - avg);
      const up = await api(page).post(`${INV}/items/${itemId}/adjust`, { qty: 1, valueCents: avg, idempotencyKey: `${tag}-up`, reason: tag });
      expectOk(up, 'adjust +1');
      item = await getItem(page, itemId!);
      expect(item.onHandQty).toBe(10);
      expect(item.onHandValueCents).toBe(amount);

      // The web Items tab shows the item (desktop plugin page).
      await page.goto('/agentbook/expenses/items');
      await expect(page.getByText(`${tag} widget`)).toBeVisible({ timeout: 20_000 });

      // Unwind: void the payment, then the bill — the purchase movement reverses with it.
      const got = await api(page).get(`${EXPENSE}/bills/${billId}`);
      for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
        expectOk(await api(page).delete(`${EXPENSE}/bills/${billId}/payments/${p.id}`), 'void payment');
      }
      expectOk(await api(page).delete(`${EXPENSE}/bills/${billId}`), 'void bill');
      item = await getItem(page, itemId!);
      expect(item.onHandQty, 'stock back to zero').toBe(0);
      expect(item.onHandValueCents, 'value exactly zero').toBe(0);
      expectOk(await api(page).delete(`${INV}/items/${itemId}`), 'soft-delete item');
      expect((await api(page).get(`${INV}/items/${itemId}`)).status, 'deleted item is gone').toBe(404);
      itemId = null;

      const end = await trialBalance(page);
      for (const code of TOUCHED) {
        // Shrinkage: −avg then +avg (found stock credits 5995) nets to zero.
        expect(delta(baseline, end, code), `account ${code} back to baseline`).toBe(0);
      }
      expect(end.balanced, 'trial balance balances').toBe(true);
      billId = null;
    });
  });
}
