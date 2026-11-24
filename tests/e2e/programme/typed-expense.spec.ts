import { test, expect, type Page } from '@playwright/test';
import { amountInputText, getExpense, listCategoryAccounts, runTag, todayIso, type ExpenseAccount, type Persona } from '../mobile-app/fixtures';
import { SEL } from '../mobile-app/selectors';
import { api, expectOk } from '../nightly/helpers/api';
import { computeLineTax, defaultTaxCode } from '../../../packages/agentbook-jurisdictions/src/tax-codes';
import {
  EXPENSE, PERSONAS, expenseIdsByQuery, linesDelta, openPersona, returnLines, say, tbDelta, tbMoved, trialBalance,
  type Ctx, type ReturnLines, type Tb,
} from './lib';

/**
 * J-typed-expense (R-TAX-3, R-TAX-6) — a tax-typed expense end to end, across PR 1 (category), 2a (ledger writer),
 * 2b (tax codes) and the chat skill, on a DEPLOYED site for maya (CA), alex (US), sydney (AU).
 *
 * Per persona, every fixture tagged, dated today and deleted by the test:
 *   1. CHAT "Spent $X incl GST at <tag>" (AU/CA) / "Spent $X at <tag>" (US) → exactly one expense whose tax code and
 *      recoverable tax are the engine's; the books moved by net / 2100 recoverable / cash −gross.
 *   2. MOBILE CAPTURE: the tax row prefills the market's default code (inclusive) and one Save books the engine split;
 *      US shows no tax row and books the gross.
 *   3. API typed create with NO category → net on 6999 suspense, recoverable on 2100; reclassify out of suspense →
 *      the net moves 6999 → category, 2100/cash untouched; edit amount → recomputed split; recategorise → net moves;
 *      delete → all lines reversed.
 * Every step: trial-balance deltas on the touched codes + it balances; the market's return (AU BAS 1B/G11, CA line
 * 108 ITC) moves by exactly the recoverable; finally every code and return line is back at the baseline.
 */
test.describe.configure({ mode: 'serial' });

interface Row { id: string; amountCents: number; taxCode: string | null; recoverableTaxCents: number | null; categoryId: string | null }

for (const persona of PERSONAS) {
  test.describe(`typed expense journey — ${persona}`, () => {
    let ctx: Ctx;
    const tag = runTag(`E2EJTX${persona.slice(0, 2).toUpperCase()}`);
    const created: string[] = [];
    let cats: ExpenseAccount[];
    let allCats: ExpenseAccount[];
    let tb0: Tb;
    let rl0: ReturnLines;
    let registered = false;

    /** The engine's recoverable tax for `gross` under `code` (inclusive), for this tenant. */
    const recoverable = (gross: number, code: string | null) => {
      if (!code || !registered) return 0;
      return computeLineTax({
        jurisdiction: ctx.cfg.jurisdiction as 'ca' | 'au', region: ctx.cfg.region, taxCode: code, amountCents: gross, inclusive: true,
        registration: { gstRegistered: true, qstRegistered: ctx.cfg.qstRegistered },
      }).recoverableTaxCents;
    };
    const row = async (id: string): Promise<Row> => (await getExpense(ctx.page, id)).data.data as Row;
    const codeOf = (accountId: string | null) => (accountId ? allCats.find((c) => c.id === accountId)?.code ?? null : '6999');

    /** One step: `net` moved on each P&L code given, 2100 by `rec`, cash by −(sum), TB balanced, return by `rec`. */
    async function step(act: () => Promise<void>, net: Record<string, number>, rec: number, cashMoves = true) {
      const page = ctx.page;
      const tb = await trialBalance(page);
      const rl = await returnLines(page, ctx.cfg.jurisdiction);
      await act();
      const tb1 = await trialBalance(page);
      for (const [code, cents] of Object.entries(net)) expect(tbDelta(tb, tb1, code), `account ${code} moved by`).toBe(cents);
      expect(tbDelta(tb, tb1, '2100'), '2100 recoverable tax moved by').toBe(rec);
      const gross = Object.values(net).reduce((s, v) => s + v, 0) + rec;
      expect(tbDelta(tb, tb1, '1000'), 'cash moved by minus the gross').toBe(cashMoves ? 0 - gross : 0);
      expect(tb1.balanced, 'trial balance balances').toBe(true);
      const d = linesDelta(rl, await returnLines(page, ctx.cfg.jurisdiction));
      if (ctx.cfg.jurisdiction === 'au') expect([d.b1, d.g11], 'BAS 1B / G11 moved by').toEqual([rec, cashMoves ? gross : 0]);
      if (ctx.cfg.jurisdiction === 'ca') expect(d.itc, 'GST/HST return line 108 (ITC) moved by').toBe(rec);
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
      registered = ctx.cfg.jurisdiction !== 'us' && ctx.cfg.gstRegistered === true;
      if (persona !== 'alex') {
        expect(ctx.cfg.gstRegistered, `${persona} must be GST-registered (persona definition). Run: npx tsx agentbook/seed-persona-tax-registration.ts --apply`).toBe(true);
      }
      allCats = await listCategoryAccounts(ctx.page);
      cats = allCats.filter((c) => !/meal|entertain/i.test(c.name));
      expect(cats.length, 'two non-meals expense categories').toBeGreaterThan(1);
      tb0 = await trialBalance(ctx.page);
      rl0 = await returnLines(ctx.page, ctx.cfg.jurisdiction);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      try { for (const id of await expenseIdsByQuery(ctx.page, tag)) if (!created.includes(id)) created.push(id); } catch { /* sweep tracked */ }
      for (const id of created) await api(ctx.page).delete(`${EXPENSE}/expenses/${id}`).catch(() => undefined);
      await ctx.context.close().catch(() => undefined);
    });

    test('chat: "$X incl GST" records one typed expense with the engine split (US: gross, no tax)', async () => {
      const page = ctx.page;
      const vendor = `${tag}CHAT`;
      const dollars = 110 + Math.floor(Math.random() * 40);
      const text = persona === 'alex' ? `Spent $${dollars} at ${vendor}` : `Spent $${dollars} incl GST at ${vendor}`;
      let id = '';
      const tb = await trialBalance(page);
      const rl = await returnLines(page, ctx.cfg.jurisdiction);
      const reply = await say(page, text);
      expect(reply.skillUsed, `chat handled "${text}" as`).toBe('record-expense');
      await expect.poll(async () => (await expenseIdsByQuery(page, vendor)).length, { timeout: 20_000 }).toBe(1);
      [id] = await expenseIdsByQuery(page, vendor);
      created.push(id);
      const r = await row(id);
      const wantCode = persona === 'alex' ? null : 'GST';
      expect([r.amountCents, r.taxCode ?? null], 'gross and tax code from the phrase').toEqual([dollars * 100, wantCode]);
      const rec = recoverable(r.amountCents, r.taxCode);
      if (persona !== 'alex') expect(rec, 'a registrant recovers some GST').toBeGreaterThan(0);
      expect(r.recoverableTaxCents ?? 0, 'row recoverable = engine').toBe(rec);
      const tb1 = await trialBalance(page);
      expect(tbDelta(tb, tb1, codeOf(r.categoryId) as string), 'net on the booked account').toBe(r.amountCents - rec);
      expect([tbDelta(tb, tb1, '2100'), tbDelta(tb, tb1, '1000')]).toEqual([rec, 0 - r.amountCents]);
      expect(tb1.balanced).toBe(true);
      const d = linesDelta(rl, await returnLines(page, ctx.cfg.jurisdiction));
      if (persona === 'sydney') expect([d.b1, d.g11]).toEqual([rec, r.amountCents]);
      if (persona === 'maya') expect(d.itc).toBe(rec);
      await step(async () => { expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete chat expense'); },
        { [codeOf(r.categoryId) as string]: 0 - (r.amountCents - rec) }, 0 - rec);
      created.splice(created.indexOf(id), 1);
    });

    test('mobile Capture: tax prefilled with the default code in the same confirm; one Save books the split', async () => {
      test.setTimeout(150_000);
      const { page, t, formatLocale } = ctx;
      const vendor = `${tag}CAP`;
      const dollars = 113;
      const code = persona === 'alex' ? null : defaultTaxCode(ctx.cfg.jurisdiction as 'ca' | 'au', ctx.cfg.region);
      const tb = await trialBalance(page);
      await page.goto('/app/capture');
      await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
      await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
      const taxReq = page.waitForResponse((r) => new URL(r.url()).pathname === `${EXPENSE}/tax-codes`, { timeout: 15_000 });
      await page.getByLabel(t('mobile.capture.field_amount'), { exact: true }).fill(amountInputText(dollars, formatLocale));
      await page.getByLabel(t('mobile.capture.field_vendor'), { exact: true }).fill(vendor);
      await taxReq;
      if (code) {
        await expect(page.getByTestId(SEL.capture.taxRow)).toBeVisible();
        await expect(page.getByTestId(`capture-tax-code-${code}`)).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId(SEL.capture.taxModeInclusive)).toHaveAttribute('aria-checked', 'true');
      } else {
        await expect(page.getByTestId(SEL.capture.taxRow)).toHaveCount(0);
      }
      await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
      await expect(page.getByRole('button', { name: t('mobile.capture.snap') })).toBeVisible();
      await expect.poll(async () => (await expenseIdsByQuery(page, vendor)).length, { timeout: 20_000 }).toBe(1);
      const [id] = await expenseIdsByQuery(page, vendor);
      created.push(id);
      const r = await row(id);
      const rec = recoverable(dollars * 100, code);
      expect([r.amountCents, r.taxCode ?? null, r.recoverableTaxCents ?? 0]).toEqual([dollars * 100, code, rec]);
      const tb1 = await trialBalance(page);
      expect(tbDelta(tb, tb1, codeOf(r.categoryId) as string)).toBe(r.amountCents - rec);
      expect([tbDelta(tb, tb1, '2100'), tbDelta(tb, tb1, '1000'), tb1.balanced]).toEqual([rec, 0 - r.amountCents, true]);
      await step(async () => { expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete capture expense'); },
        { [codeOf(r.categoryId) as string]: 0 - (r.amountCents - rec) }, 0 - rec);
      created.splice(created.indexOf(id), 1);
    });

    test('suspense → reclassify → edit → recategorise → delete, balanced books and returns every step', async () => {
      const page = ctx.page;
      const [first, second] = cats;
      const code = persona === 'alex' ? null : defaultTaxCode(ctx.cfg.jurisdiction as 'ca' | 'au', ctx.cfg.region);
      const g1 = 11300, g2 = 22600;
      const r1 = recoverable(g1, code), r2 = recoverable(g2, code);
      let id = '';
      await step(async () => {
        const res = await api(page).post(`${EXPENSE}/expenses`, {
          amountCents: g1, date: todayIso(), vendor: `${tag}SUSP`, description: `${tag} typed uncategorised`, currency: ctx.cfg.currency,
          ...(code ? { taxCode: code, taxInclusive: true } : {}),
        });
        expectOk(res, 'create uncategorised typed expense');
        id = res.data.data.id;
        created.push(id);
      }, { '6999': g1 - r1 }, r1);
      expect((await row(id)).categoryId ?? null, 'saved uncategorised').toBeNull();

      await step(async () => { expectOk(await api(page).put(`${EXPENSE}/expenses/${id}`, { categoryId: first.id, categorySource: 'user' }), 'reclassify'); },
        { '6999': 0 - (g1 - r1), [first.code]: g1 - r1 }, 0, false);
      const tbMid = await trialBalance(page);
      expect(tbMid.byCode['6999'] ?? 0, 'nothing of this run left on suspense').toBe(tb0.byCode['6999'] ?? 0);

      await step(async () => { expectOk(await api(page).put(`${EXPENSE}/expenses/${id}`, { amountCents: g2 }), 'edit amount'); },
        { [first.code]: (g2 - r2) - (g1 - r1) }, r2 - r1);
      expect([(await row(id)).amountCents, (await row(id)).recoverableTaxCents ?? 0]).toEqual([g2, r2]);

      await step(async () => { expectOk(await api(page).put(`${EXPENSE}/expenses/${id}`, { categoryId: second.id }), 'recategorise'); },
        { [first.code]: 0 - (g2 - r2), [second.code]: g2 - r2 }, 0, false);

      await step(async () => { expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete'); },
        { [second.code]: 0 - (g2 - r2) }, 0 - r2);
      expect((await getExpense(page, id)).status).toBe(404);
      created.splice(created.indexOf(id), 1);
    });

    test('baseline: nothing tagged is left; trial balance and return lines are exactly where they started', async () => {
      const page = ctx.page;
      expect(await expenseIdsByQuery(page, tag)).toEqual([]);
      const tb = await trialBalance(page);
      expect(tbMoved(tb0, tb), 'codes not back at baseline (writes elsewhere in the books would also show here)').toEqual({});
      expect(linesDelta(rl0, await returnLines(page, ctx.cfg.jurisdiction))).toEqual({ b1: 0, g10: 0, g11: 0, w1: 0, w2: 0, itc: 0 });
    });
  });
}
