import { test, expect, type Page } from '@playwright/test';
import { addDaysIso, runTag, todayIso, type Persona } from '../mobile-app/fixtures';
import { api, expectOk } from '../nightly/helpers/api';
import { EXPENSE, INVOICE, PERSONAS, openPersona, tbDelta, tbMoved, trialBalance, unwindBill, type Ctx, type Tb } from './lib';

/**
 * J-inventory-sale (R-INV-2) — purchase → weighted-average stock → sale → COGS → void, across PR 3bc (bills with an
 * item), 5A (stock) and 5B (COGS), on a DEPLOYED site for maya (CA), alex (US), sydney (AU).
 *
 * Per persona, all tagged and unwound by the test:
 *   two paid bills for one tagged item at DIFFERENT unit costs (10 units, then 3 units) → 1500 = total, avg = total/13
 *   (not a whole cent) → invoice 1 sells 4: 1500 −c1, COGS (5990 US/CA, 5000 AU) +c1 with c1 = round(4 × total / 13)
 *   → marking it sent posts nothing more (once per invoice line) → invoice 2 sells the other 9: COGS +c2 = total − c1,
 *   on-hand qty 0 AND value exactly 0 → COGS-by-period for this month rose by exactly total → void invoice 2 then 1:
 *   stock, value and every account restored → bills unwound, fixtures deleted, every code back at baseline.
 * Precondition (read only): trackInventory is ON for the persona.
 */
test.describe.configure({ mode: 'serial' });

const INV = `${EXPENSE}/inventory`;
const COGS_CODE: Record<Persona, string> = { alex: '5990', maya: '5990', sydney: '5000' } as Record<Persona, string>;
const ENABLE = 'sign in as the persona and PUT /api/v1/agentbook-core/tenant-config {"trackInventory":true}';

for (const persona of PERSONAS) {
  test.describe(`inventory sale journey — ${persona}`, () => {
    let ctx: Ctx;
    const tag = runTag(`E2EJINV${persona.slice(0, 2).toUpperCase()}`);
    const bills: string[] = [];
    const invoices: string[] = [];
    let itemId: string | null = null;
    let clientId: string | null = null;
    let tb0: Tb;

    const item = async (page: Page) => (await api(page).get(`${INV}/items/${itemId}`)).data.data as { onHandQty: number; onHandValueCents: number };
    const monthCogs = async (page: Page) => {
      const month = todayIso().slice(0, 7);
      const res = await api(page).get(`${INV}/cogs?granularity=month&from=${month}-01`);
      expectOk(res, 'COGS by period');
      return (res.data.data.periods as Array<{ period: string; cogsCents: number }>).find((p) => p.period === month)?.cogsCents ?? 0;
    };
    const buy = async (page: Page, qty: number, amountCents: number, n: string) => {
      const bill = await api(page).post(`${EXPENSE}/bills`, {
        vendorName: `${tag} supplier`, description: `${tag} ${qty} widgets ${n}`, amountCents,
        billDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), itemId, qty, taxCode: null, idempotencyKey: `${tag}-${n}`,
      });
      expectOk(bill, `create item bill ${n}`);
      bills.push(bill.data.data.id);
      expectOk(await api(page).post(`${EXPENSE}/bills/${bill.data.data.id}?action=pay`, {}), `pay item bill ${n}`);
    };
    const sell = async (page: Page, qty: number) => {
      const inv = await api(page).post(`${INVOICE}/invoices`, {
        clientId, issuedDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), status: 'draft',
        lines: [{ description: `${tag} widgets`, quantity: qty, rateCents: 2500, itemId }],
      });
      expectOk(inv, `invoice selling ${qty}`);
      invoices.push(inv.data.data.id);
      return inv.data.data.id as string;
    };

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
      expect(ctx.cfg.trackInventory, `${persona} must track inventory (precondition). Enable it: ${ENABLE}`).toBe(true);
      tb0 = await trialBalance(ctx.page);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      const page = ctx.page;
      try {
        for (const id of [...invoices].reverse()) {
          const got = await api(page).get(`${INVOICE}/invoices/${id}`);
          if (got.status === 200 && got.data.data.status !== 'void') await api(page).post(`${INVOICE}/invoices/${id}/void`, {});
          await api(page).delete(`${INVOICE}/invoices/${id}`);
        }
        for (const id of bills) await unwindBill(page, id);
        if (clientId) await api(page).delete(`${INVOICE}/clients/${clientId}`);
        if (itemId) await api(page).delete(`${INV}/items/${itemId}`);
      } catch (err) {
        console.error(`[inventory-sale journey] afterAll unwind failed for ${persona}:`, err);
      }
      await ctx.context.close().catch(() => undefined);
    });

    test('weighted-average COGS once per line, exact zero at qty 0, void restores, books back at baseline', async () => {
      const page = ctx.page;
      const cogs = COGS_CODE[persona];
      const a = 5000 + Math.floor(Math.random() * 40) * 10; // 10 units
      const b = 1001 + Math.floor(Math.random() * 20); // 3 units at a different unit cost
      const total = a + b;
      const c1 = Math.round((4 * total) / 13);
      const c2 = total - c1;
      const cogsMonth0 = await monthCogs(page);

      const it = await api(page).post(`${INV}/items`, { name: `${tag} widget`, sku: tag, unit: 'each' });
      expectOk(it, 'create item');
      itemId = it.data.data.id;
      await buy(page, 10, a, 'a');
      await buy(page, 3, b, 'b');
      const stocked = await trialBalance(page);
      expect(tbDelta(tb0, stocked, '1500'), '1500 = both purchases').toBe(total);
      expect(await item(page)).toMatchObject({ onHandQty: 13, onHandValueCents: total });

      const client = await api(page).post(`${INVOICE}/clients`, { name: `${tag} customer` });
      expectOk(client, 'create client');
      clientId = client.data.data.id;

      const inv1 = await sell(page, 4);
      const sold1 = await trialBalance(page);
      expect([tbDelta(stocked, sold1, '1500'), tbDelta(stocked, sold1, cogs)], `4 units at average cost to ${cogs}`).toEqual([0 - c1, c1]);
      expect(sold1.balanced).toBe(true);
      expect(await item(page)).toMatchObject({ onHandQty: 9, onHandValueCents: total - c1 });

      expectOk(await api(page).patch(`${INVOICE}/invoices/${inv1}`, { status: 'sent' }), 'mark invoice 1 sent');
      const sent = await trialBalance(page);
      expect([tbDelta(sold1, sent, '1500'), tbDelta(sold1, sent, cogs)], 'issuing the invoice relieves nothing again').toEqual([0, 0]);

      const inv2 = await sell(page, 9);
      const sold2 = await trialBalance(page);
      expect([tbDelta(sent, sold2, '1500'), tbDelta(sent, sold2, cogs)], 'the last 9 carry the remainder').toEqual([0 - c2, c2]);
      expect(await item(page), 'qty 0 means value exactly 0').toMatchObject({ onHandQty: 0, onHandValueCents: 0 });
      expect(tbDelta(tb0, sold2, '1500'), '1500 back where it started at qty 0').toBe(0);
      expect((await monthCogs(page)) - cogsMonth0, 'COGS-by-period this month rose by exactly the cost sold').toBe(total);

      expectOk(await api(page).post(`${INVOICE}/invoices/${inv2}/void`, {}), 'void invoice 2');
      expect(await item(page)).toMatchObject({ onHandQty: 9, onHandValueCents: total - c1 });
      expect(tbMoved(sent, await trialBalance(page)), 'void 2 restores every account').toEqual({});
      expectOk(await api(page).post(`${INVOICE}/invoices/${inv1}/void`, {}), 'void invoice 1');
      expect(await item(page)).toMatchObject({ onHandQty: 13, onHandValueCents: total });
      expect(tbMoved(stocked, await trialBalance(page)), 'void 1 restores every account').toEqual({});
      expect((await monthCogs(page)) - cogsMonth0, 'COGS report net of voids').toBe(0);

      for (const id of invoices) expectOk(await api(page).delete(`${INVOICE}/invoices/${id}`), 'soft-delete invoice');
      invoices.length = 0;
      for (const id of bills) await unwindBill(page, id);
      for (const id of bills) expect((await api(page).get(`${EXPENSE}/bills/${id}`)).data.data.status).toBe('cancelled');
      bills.length = 0;
      expectOk(await api(page).delete(`${INVOICE}/clients/${clientId}`), 'soft-delete client');
      clientId = null;
      expectOk(await api(page).delete(`${INV}/items/${itemId}`), 'soft-delete item');
      itemId = null;
      const end = await trialBalance(page);
      expect(tbMoved(tb0, end), 'every code back at baseline').toEqual({});
      expect(end.balanced).toBe(true);
    });
  });
}
