import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle } from './helpers';
import { addDaysIso, listCategoryAccounts, runTag, todayIso, type ExpenseAccount, type Persona } from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';
import { computeLineTax } from '../../../packages/agentbook-jurisdictions/src/tax-codes';

/**
 * PR 3bc — bills post AP at entry (accrual tenants, flag `purchases_at_entry`), proved on a DEPLOYED site for
 * alex (US), maya (CA) and sydney (AU).
 *
 * Phase `flag-on` (default; 3bc.10 after `agentbook/enable-purchases-at-entry.ts --apply`):
 *   create an at_entry bill → balance-sheet AP (2000) +total, category +net, 2100 +recoverable, cash unchanged;
 *   pay half → AP −half, cash −half, NO expense row (counted by vendor tag); pay the rest → AP back, status paid;
 *   GET purchases lists the bill once with badge 'paid'; a second bill is voided (every account back);
 *   sydney: BAS 1B moves by exactly the recoverable on the accrual date (or by payment pro-rata on cash GST).
 *   Fails loudly — never skips — when the persona's new bill is not at_entry, naming the enable script.
 * Phase `flag-off` (BILLS_E2E_PHASE=flag-off; 3bc.10 "deploy with flag off, verify legacy bills unchanged"):
 *   a bill is created at_payment with no ledger impact and pays exactly as before: DR category / CR 1000.
 *
 * Fixtures are tagged, dated today (UTC), created by the test and unwound in afterAll (payments voided, bill
 * voided); seeded data is never touched and tenant config is only read. Assertions are before/after deltas on the
 * accounts this run touches.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';
const PHASE = process.env.BILLS_E2E_PHASE === 'flag-off' ? 'flag-off' : 'flag-on';
const ENABLE = 'npx tsx agentbook/enable-purchases-at-entry.ts --apply';

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface Ctx { context: BrowserContext; page: Page; cfg: { jurisdiction: string; region: string | null; gstRegistered: boolean | null; gstReportingBasis: string | null; accountingBasis: string | null } }
interface Bill { id: string; status: string; postingMode: string; amountCents: number; paidCents: number; recoverableTaxCents: number | null; taxCents: number | null }

async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true, byCode };
}
const d = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);

/** Balance-sheet AP (2000) as the report shows it (journal 2000 + derived legacy AP). */
async function bsAp(page: Page): Promise<{ ap: number; balanced: boolean }> {
  const res = await api(page).get(`/api/v1/agentbook-tax/reports/balance-sheet?asOfDate=${addDaysIso(todayIso(), 1)}`);
  expectOk(res, 'balance sheet');
  const l = (res.data.data.liabilities as Array<{ code: string; balanceCents: number }>).find((x) => x.code === '2000');
  return { ap: l?.balanceCents ?? 0, balanced: res.data.data.balanced === true };
}

async function expenseIdsByTag(page: Page, tag: string): Promise<string[]> {
  const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(tag)}&limit=100`);
  expectOk(res, `expenses q=${tag}`);
  return (res.data.data as Array<{ id: string }>).map((r) => r.id);
}

function quarterOf(iso: string) {
  const t = new Date(`${iso}T00:00:00Z`);
  const q = Math.floor(t.getUTCMonth() / 3);
  return {
    s: new Date(Date.UTC(t.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10),
    e: new Date(Date.UTC(t.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10),
  };
}
async function bas1B(page: Page): Promise<number> {
  const { s, e } = quarterOf(todayIso());
  const res = await api(page).get(`/api/v1/agentbook-tax/au/bas-return?periodStart=${s}&periodEnd=${e}`);
  expectOk(res, 'BAS return');
  return res.data.data.label1BGstOnPurchasesCents as number;
}

async function openPersona(browser: import('@playwright/test').Browser, baseURL: string | undefined, persona: Persona): Promise<Ctx> {
  const context = await newPersonaContext(browser, baseURL);
  const page = await context.newPage();
  await loginAs(page, persona);
  await page.goto('/app/capture');
  await settle(page);
  const t = catalogT((await pageLocales(page)).stringLocale);
  // The catalog locale is only trusted once the page's own h1 renders in it.
  await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
  const res = await api(page).get(`${CORE}/tenant-config`);
  expectOk(res, 'tenant config');
  const c = res.data.data;
  return {
    context, page,
    cfg: { jurisdiction: c.jurisdiction, region: c.region ?? null, gstRegistered: c.gstRegistered ?? null, gstReportingBasis: c.gstReportingBasis ?? null, accountingBasis: c.accountingBasis ?? null },
  };
}

async function createBill(page: Page, body: Record<string, unknown>): Promise<Bill> {
  const res = await api(page).post(`${EXPENSE}/bills`, body);
  expectOk(res, 'create bill');
  return res.data.data as Bill;
}
async function pay(page: Page, id: string, amountCents?: number): Promise<{ bill: Bill; paymentId: string }> {
  const res = await api(page).post(`${EXPENSE}/bills/${id}?action=pay`, amountCents === undefined ? {} : { amountCents });
  expectOk(res, 'pay bill');
  return { bill: res.data.data as Bill, paymentId: res.data.payment.id as string };
}

/** Unwind a fixture bill: void its active payments, then void the bill. Logs, never throws. */
async function unwind(ctx: Ctx | undefined, ids: string[]) {
  if (!ctx) return;
  for (const id of ids) {
    try {
      const got = await api(ctx.page).get(`${EXPENSE}/bills/${id}`);
      if (got.status === 404) continue;
      const bill = got.data.data as Bill & { payments: Array<{ id: string; voidedAt: string | null }> };
      for (const p of bill.payments.filter((x) => !x.voidedAt)) {
        const r = await api(ctx.page).delete(`${EXPENSE}/bills/${id}/payments/${p.id}`);
        if (r.status >= 400) console.error(`[bills e2e] afterAll could not void payment ${p.id} of ${id}: ${r.status}`);
      }
      if (bill.status !== 'cancelled') {
        const r = await api(ctx.page).delete(`${EXPENSE}/bills/${id}`);
        if (r.status >= 400) console.error(`[bills e2e] afterAll could not void bill ${id}: ${r.status}`);
        else console.log(`[bills e2e] afterAll voided leftover fixture bill ${id}`);
      }
    } catch (err) {
      console.error(`[bills e2e] afterAll could not unwind bill ${id}:`, err);
    }
  }
  try { await ctx.context.close(); } catch (err) { console.error('[bills e2e] afterAll context close failed:', err); }
}

async function firstPlainCategory(page: Page): Promise<ExpenseAccount> {
  const cats = (await listCategoryAccounts(page)).filter((c) => !/meal|entertain/i.test(c.name));
  expect(cats.length, 'persona has a non-meals expense category').toBeGreaterThan(0);
  return cats[0];
}

function atEntryLifecycle(persona: Persona, gross: number) {
  test.describe(`bills at entry - ${persona}`, () => {
    let ctx: Ctx;
    const created: string[] = [];
    const tag = runTag(`E2EBILL${persona.slice(0, 2).toUpperCase()}`);
    let cat: ExpenseAccount;
    let bill: Bill;
    let rec = 0;

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      test.skip(reason !== null, reason ?? '');
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
      expect(ctx.cfg.accountingBasis ?? 'accrual', `${persona} is an accrual tenant (persona definition)`).not.toBe('cash');
      cat = await firstPlainCategory(ctx.page);
    });
    test.afterAll(async () => unwind(ctx, created));

    test('create: an at_entry bill puts the total on AP, the net on the category, the recoverable on 2100, cash unchanged', async () => {
      const { page } = ctx;
      const tb0 = await trialBalance(page);
      const bs0 = await bsAp(page);
      const b0 = persona === 'sydney' ? await bas1B(page) : 0;
      const exp0 = await expenseIdsByTag(page, tag);
      bill = await createBill(page, {
        vendorName: `${tag} Supplies`, description: `${tag} bill`, amountCents: gross, categoryCode: cat.code,
        billDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), idempotencyKey: `${tag}-a`,
      });
      created.push(bill.id);
      expect(bill.postingMode, `${persona}'s new bill must post at entry. Enable the flag for this tenant: ${ENABLE}`).toBe('at_entry');
      rec = bill.recoverableTaxCents ?? 0;
      if (persona === 'sydney') {
        const golden = computeLineTax({ jurisdiction: 'au', taxCode: 'GST', amountCents: gross, inclusive: true, registration: { gstRegistered: true, qstRegistered: null } }).recoverableTaxCents;
        expect([golden, rec], 'AU: $110 incl GST is 1000 recoverable').toEqual([1000, 1000]);
      }
      if (persona === 'alex') expect(rec, 'US: nothing recoverable').toBe(0);
      if (persona === 'maya') expect(rec, 'CA registrant: an ITC is credited').toBeGreaterThan(0);
      const tb1 = await trialBalance(page);
      const bs1 = await bsAp(page);
      expect({
        ap: d(tb0, tb1, '2000'), cat: d(tb0, tb1, cat.code), tax: d(tb0, tb1, '2100'), cash: d(tb0, tb1, '1000'),
      }).toEqual({ ap: 0 - gross, cat: gross - rec, tax: rec, cash: 0 });
      expect(bs1.ap - bs0.ap, 'balance-sheet AP rose by the total').toBe(gross);
      expect([tb1.balanced, bs1.balanced]).toEqual([true, true]);
      expect(await expenseIdsByTag(page, tag), 'a bill is not an expense row').toEqual(exp0);
      if (persona === 'sydney') {
        const want = (ctx.cfg.gstReportingBasis ?? 'accrual') === 'cash' ? 0 : rec;
        expect((await bas1B(page)) - b0, 'BAS 1B on the bill date (accrual) / nothing yet (cash GST)').toBe(want);
      }
    });

    test('pay half: AP down by half, cash down by half, no expense row created', async () => {
      const { page } = ctx;
      const half = Math.floor(gross / 2);
      const tb0 = await trialBalance(page);
      const bs0 = await bsAp(page);
      const b0 = persona === 'sydney' ? await bas1B(page) : 0;
      const { bill: after } = await pay(page, bill.id, half);
      expect([after.status, after.paidCents]).toEqual(['partial', half]);
      const tb1 = await trialBalance(page);
      expect({ ap: d(tb0, tb1, '2000'), cash: d(tb0, tb1, '1000'), cat: d(tb0, tb1, cat.code), tax: d(tb0, tb1, '2100') })
        .toEqual({ ap: half, cash: 0 - half, cat: 0, tax: 0 });
      expect(bs0.ap - (await bsAp(page)).ap, 'balance-sheet AP fell by half').toBe(half);
      expect(await expenseIdsByTag(page, tag), 'paying a bill never creates an expense').toEqual([]);
      if (persona === 'sydney' && ctx.cfg.gstReportingBasis === 'cash') {
        expect((await bas1B(page)) - b0, 'cash GST: 1B pro-rata by payment').toBe(Math.round((rec * half) / gross));
      }
    });

    test('pay the rest: AP back to where it was, status paid, expense counted once', async () => {
      const { page } = ctx;
      const rest = gross - Math.floor(gross / 2);
      const tb0 = await trialBalance(page);
      const { bill: after } = await pay(page, bill.id);
      expect([after.status, after.paidCents]).toEqual(['paid', gross]);
      const tb1 = await trialBalance(page);
      expect({ ap: d(tb0, tb1, '2000'), cash: d(tb0, tb1, '1000'), cat: d(tb0, tb1, cat.code) }).toEqual({ ap: rest, cash: 0 - rest, cat: 0 });
      expect(await expenseIdsByTag(page, tag)).toEqual([]);
    });

    test('GET purchases lists the bill exactly once, badge paid', async () => {
      const res = await api(ctx.page).get(`${EXPENSE}/purchases?kind=bill&limit=200`);
      expectOk(res, 'purchases');
      const mine = (res.data.data as Array<{ kind: string; id: string; status: string; amountCents: number; outstandingCents?: number }>).filter((r) => r.id === bill.id);
      expect(mine.map((r) => [r.kind, r.status, r.amountCents, r.outstandingCents])).toEqual([['bill', 'paid', gross, 0]]);
    });

    test('void path: a second bill voided leaves every touched account where it was', async () => {
      const { page } = ctx;
      const tb0 = await trialBalance(page);
      const b0 = persona === 'sydney' ? await bas1B(page) : 0;
      const second = await createBill(page, {
        vendorName: `${tag} Supplies`, description: `${tag} void`, amountCents: gross, categoryCode: cat.code,
        billDate: todayIso(), dueDate: addDaysIso(todayIso(), 30), idempotencyKey: `${tag}-b`,
      });
      created.push(second.id);
      expect(second.postingMode, `flag must be on: ${ENABLE}`).toBe('at_entry');
      expect(d(tb0, await trialBalance(page), '2000')).toBe(0 - gross);
      const res = await api(page).delete(`${EXPENSE}/bills/${second.id}`);
      expectOk(res, 'void bill');
      expect(res.data.data.status).toBe('cancelled');
      const tb1 = await trialBalance(page);
      expect({ ap: d(tb0, tb1, '2000'), cat: d(tb0, tb1, cat.code), tax: d(tb0, tb1, '2100'), cash: d(tb0, tb1, '1000') })
        .toEqual({ ap: 0, cat: 0, tax: 0, cash: 0 });
      if (persona === 'sydney') expect((await bas1B(page)) - b0, 'BAS 1B net of a voided bill').toBe(0);
    });
  });
}

function legacyAtPayment(persona: Persona, gross: number) {
  test.describe(`bills legacy at_payment (flag off) - ${persona}`, () => {
    let ctx: Ctx;
    const created: string[] = [];
    const tag = runTag(`E2EBILLL${persona.slice(0, 2).toUpperCase()}`);

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      test.skip(reason !== null, reason ?? '');
      ctx = await openPersona(browser, testInfo.project.use.baseURL, persona);
    });
    test.afterAll(async () => unwind(ctx, created));

    test('created at_payment with no ledger impact; paying books DR category / CR 1000 as before', async () => {
      const { page } = ctx;
      const cat = await firstPlainCategory(page);
      const tb0 = await trialBalance(page);
      const bill = await createBill(page, { vendorName: `${tag} Legacy`, amountCents: gross, categoryCode: cat.code, dueDate: addDaysIso(todayIso(), 14) });
      created.push(bill.id);
      expect(bill.postingMode, `flag must be OFF for ${persona} in this phase: ${ENABLE.replace('--apply', '--remove --apply')}`).toBe('at_payment');
      const tb1 = await trialBalance(page);
      expect([d(tb0, tb1, '2000'), d(tb0, tb1, cat.code), d(tb0, tb1, '1000')]).toEqual([0, 0, 0]);
      const { bill: paid } = await pay(page, bill.id);
      expect(paid.status).toBe('paid');
      const tb2 = await trialBalance(page);
      expect({ cat: d(tb1, tb2, cat.code), cash: d(tb1, tb2, '1000'), ap: d(tb1, tb2, '2000') }).toEqual({ cat: gross, cash: 0 - gross, ap: 0 });
      expect(tb2.balanced).toBe(true);
    });
  });
}

if (PHASE === 'flag-on') {
  atEntryLifecycle('alex', 12000);
  atEntryLifecycle('maya', 11300);
  atEntryLifecycle('sydney', 11000);
} else {
  legacyAtPayment('alex', 4321);
  legacyAtPayment('maya', 4321);
  legacyAtPayment('sydney', 4321);
}
