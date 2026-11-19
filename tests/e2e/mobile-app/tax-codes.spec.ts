import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, money, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import {
  PERSONA_CURRENCY,
  amountInputText,
  deleteExpenseQuietly,
  getExpense,
  listCategoryAccounts,
  pnlSnapshot,
  runTag,
  suspenseAccountId,
  todayIso,
  type ExpenseAccount,
  type Persona,
  type PnlSnapshot,
} from './fixtures';
import { SEL } from './selectors';
import { api, expectOk } from '../nightly/helpers/api';
// The engine itself, from source: every expected split below is computed by the same function the server runs,
// and the AU/CA golden values are also pinned by hand so a wrong engine cannot agree with itself.
import { computeLineTax, defaultTaxCode } from '../../../packages/agentbook-jurisdictions/src/tax-codes';

/**
 * PR 2b — purchase tax codes, proved on a DEPLOYED site for each market.
 *
 * sydney (AU): "$110 incl GST" through the API and through mobile Capture books DR category 10000 | DR 2100 1000 |
 * CR cash 11000; BAS 1B rises by exactly 1000; the typed (3-line) expense can be re-amounted, recategorised and
 * deleted with balanced books every step (PR 2a review Minor-4); an idempotency-key replay is still one expense.
 * maya (CA): the same lifecycle with her province's default code; QST is covered live only if she is in QC.
 * alex (US): no tax row on Capture and a plain 2-line gross posting.
 *
 * Fixtures are tagged, dated today (UTC), created and deleted by the test; seeded data is never touched. The test
 * never writes tenant config: sydney and maya are GST registrants by persona definition
 * (agentbook/seed-persona-tax-registration.ts), and beforeAll fails loudly if that seed has not been applied.
 * Every assertion is a before/after delta on the accounts this run touches (its category, 2100, 1000), so writes
 * elsewhere in the persona's books cannot break it; the final check is that this run's net effect is zero.
 */
test.describe.configure({ mode: 'serial' });

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';

interface Tb { balanced: boolean; byCode: Record<string, number> }
interface TenantCfg { region: string | null; gstRegistered: boolean | null; qstRegistered: boolean | null; jurisdiction: string }
interface Bas { label1BGstOnPurchasesCents: number; g10CapitalPurchasesCents: number; g11NonCapitalPurchasesCents: number }

/** Trial balance by account code (debit − credit), plus the route's own balanced flag. */
async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true && res.data.data.totalDebits === res.data.data.totalCredits, byCode };
}
const tbDelta = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);

async function tenantConfig(page: Page): Promise<TenantCfg> {
  const res = await api(page).get(`${CORE}/tenant-config`);
  expectOk(res, 'tenant config');
  const d = res.data.data;
  return { region: d.region ?? null, gstRegistered: d.gstRegistered ?? null, qstRegistered: d.qstRegistered ?? null, jurisdiction: d.jurisdiction };
}

/** The calendar quarter (UTC) holding `iso`, as the BAS route's period params. */
function quarterOf(iso: string): { periodStart: string; periodEnd: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  const s = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
  const e = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
  return { periodStart: s.toISOString().slice(0, 10), periodEnd: e.toISOString().slice(0, 10) };
}

async function bas(page: Page, iso: string): Promise<Bas> {
  const { periodStart, periodEnd } = quarterOf(iso);
  const res = await api(page).get(`/api/v1/agentbook-tax/au/bas-return?periodStart=${periodStart}&periodEnd=${periodEnd}`);
  expectOk(res, 'BAS return');
  return res.data.data as Bas;
}

/** POST /expenses with an Idempotency-Key header (the nightly api() helper sends no custom headers). */
async function postExpenseWithKey(page: Page, key: string, body: Record<string, unknown>) {
  return page.evaluate(async ({ key, body }) => {
    const r = await fetch('/api/v1/agentbook-expense/expenses', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    let data: any = null;
    try { data = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, data };
  }, { key, body });
}

async function idsByQuery(page: Page, q: string): Promise<string[]> {
  const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(q)}&limit=100`);
  expectOk(res, `list q=${q}`);
  return (res.data.data as Array<{ id: string }>).map((r) => r.id);
}

/** Expense categories whose recoverable fraction is the plain one (no CA meals 50% rule), stable order. */
async function plainCategories(page: Page): Promise<ExpenseAccount[]> {
  const cats = (await listCategoryAccounts(page)).filter((c) => !/meal|entertain/i.test(`${c.name} ${(c as { taxCategory?: string }).taxCategory ?? ''}`));
  expect(cats.length, 'persona has two non-meals expense categories').toBeGreaterThan(1);
  return cats;
}

interface Ctx {
  context: BrowserContext;
  page: Page;
  t: CatalogT;
  locale: string;
  /** Net movement this run caused, summed from every measured step delta: key -> cents. Must end at zero. */
  effect: Record<string, number>;
}
const SEED = 'agentbook/seed-persona-tax-registration.ts --apply';

async function openPersona(browser: import('@playwright/test').Browser, baseURL: string | undefined, persona: Persona, needRegistered: boolean): Promise<Ctx> {
  const context = await newPersonaContext(browser, baseURL);
  const page = await context.newPage();
  await loginAs(page, persona);
  await page.goto('/app/capture');
  await settle(page);
  const loc = await pageLocales(page);
  const t = catalogT(loc.stringLocale);
  // The catalog locale is only trusted once the page's own h1 renders in it.
  await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
  if (needRegistered) {
    // Read only. A registrant persona whose flag is not true is a broken fixture, not a reason to skip.
    const cfg = await tenantConfig(page);
    expect(cfg.gstRegistered, `${persona} must be GST-registered (persona definition). Run: npx tsx ${SEED}`).toBe(true);
  }
  return { context, page, t, locale: loc.formatLocale, effect: {} };
}

async function closePersona(ctx: Ctx | undefined, created: string[]) {
  if (!ctx) return;
  for (const id of created) {
    try {
      await deleteExpenseQuietly(ctx.page, id);
      console.log(`[tax-codes e2e] afterAll deleted leftover fixture ${id}`);
    } catch (err) {
      console.error(`[tax-codes e2e] afterAll could not delete fixture ${id}:`, err);
    }
  }
  try { await ctx.context.close(); } catch (err) { console.error('[tax-codes e2e] afterAll context close failed:', err); }
}

/** Record a measured delta into the run's net effect. */
function track(ctx: Ctx, key: string, cents: number) { ctx.effect[key] = (ctx.effect[key] ?? 0) + cents; }

/**
 * One step: each account in `pnl` moved by exactly its cents, 2100 by `gst`, 1000 by minus the gross, and the trial
 * balance still balances. Only the accounts this run touches are compared, so unrelated writes cannot fail it.
 */
async function expectStep(ctx: Ctx, before: { pnl: PnlSnapshot; tb: Tb }, pnl: Record<string, number>, gst: number) {
  const page = ctx.page;
  const after = { pnl: await pnlSnapshot(page), tb: await trialBalance(page) };
  for (const [acct, cents] of Object.entries(pnl)) {
    const d = (after.pnl.expenseByAccount[acct] ?? 0) - (before.pnl.expenseByAccount[acct] ?? 0);
    expect(d, `P&L account ${acct} moved by`).toBe(cents);
    track(ctx, `pnl:${acct}`, d);
  }
  const dGst = tbDelta(before.tb, after.tb, '2100');
  expect(dGst, '2100 GST control moved by').toBe(gst);
  track(ctx, 'tb:2100', dGst);
  const gross = Object.values(pnl).reduce((s, v) => s + v, 0) + gst;
  const dCash = tbDelta(before.tb, after.tb, '1000');
  // 0 - gross, not -gross: a no-op step has gross 0, and toBe uses Object.is, where -0 !== 0.
  expect(dCash, 'cash credited by the gross').toBe(0 - gross);
  track(ctx, 'tb:1000', dCash);
  expect(after.tb.balanced, 'trial balance balances').toBe(true);
  return after;
}
/** The account a saved expense booked to: its category, or the 6999 suspense account when it was saved uncategorised. */
async function bookedAccount(page: Page, row: { categoryId?: string | null }): Promise<string> {
  if (row.categoryId) return row.categoryId;
  const susp = suspenseAccountId(await pnlSnapshot(page));
  expect(susp, 'an uncategorised save books to the 6999 suspense account').toBeTruthy();
  return susp as string;
}
const snap = async (page: Page) => ({ pnl: await pnlSnapshot(page), tb: await trialBalance(page) });

/**
 * The typed lifecycle shared by AU and CA: create (with an idempotency key, then replayed), edit amount, change
 * category, delete. `recoverable(gross)` is the engine's expected recoverable tax for a gross amount. With `bas`,
 * every step also asserts the BAS 1B/G10/G11 delta captured immediately around that step (AU).
 */
function typedLifecycle(opts: {
  persona: Persona;
  get: () => Ctx;
  created: string[];
  taxCode: () => string;
  firstGross: number;
  secondGross: number;
  recoverable: (gross: number) => number;
  bas?: boolean;
}) {
  const tag = runTag(`E2ETAX${opts.persona.slice(0, 2).toUpperCase()}`);
  let first: ExpenseAccount;
  let second: ExpenseAccount;
  let id: string | null = null;
  const key = crypto.randomUUID();
  const date = todayIso();
  let body: Record<string, unknown>;

  /** Run `act` and assert the BAS moved by exactly { 1B, G10, G11 } across it (AU only; otherwise just runs it). */
  async function aroundBas(ctx: Ctx, act: () => Promise<void>, d: { b1: number; g10: number; g11: number }) {
    if (!opts.bas) return act();
    const before = await bas(ctx.page, date);
    await act();
    const after = await bas(ctx.page, date);
    const got = {
      b1: after.label1BGstOnPurchasesCents - before.label1BGstOnPurchasesCents,
      g10: after.g10CapitalPurchasesCents - before.g10CapitalPurchasesCents,
      g11: after.g11NonCapitalPurchasesCents - before.g11NonCapitalPurchasesCents,
    };
    expect(got, 'BAS 1B / G10 / G11 moved by').toEqual(d);
    for (const [k2, v] of Object.entries(got)) track(ctx, `bas:${k2}`, v);
  }

  test('typed create books the net on the category and the recoverable tax on 2100', async () => {
    const ctx = opts.get();
    const { page } = ctx;
    [first, second] = await plainCategories(page);
    const rec = opts.recoverable(opts.firstGross);
    expect(rec, 'the engine credits some tax for a registrant').toBeGreaterThan(0);
    body = {
      amountCents: opts.firstGross, taxCode: opts.taxCode(), taxInclusive: true, date,
      vendor: `${tag} Vendor`, description: `${tag} typed`, currency: PERSONA_CURRENCY[opts.persona],
      categoryId: first.id, categorySource: 'user',
    };
    await aroundBas(ctx, async () => {
      const before = await snap(page);
      const res = await postExpenseWithKey(page, key, body);
      expectOk(res, 'create typed expense');
      id = res.data.data.id as string;
      opts.created.push(id);
      await expectStep(ctx, before, { [first.id]: opts.firstGross - rec }, rec);
    }, { b1: rec, g10: 0, g11: opts.firstGross });
    const row = (await getExpense(page, id as string)).data.data;
    expect([row.amountCents, row.taxCode, row.recoverableTaxCents]).toEqual([opts.firstGross, opts.taxCode(), rec]);
  });

  test('replaying the same idempotency key is still one expense and moves nothing', async () => {
    const ctx = opts.get();
    const before = await snap(ctx.page);
    const res = await postExpenseWithKey(ctx.page, key, body);
    expectOk(res, 'replay typed expense');
    expect(res.data.data.id, 'replay returns the original').toBe(id);
    expect(await idsByQuery(ctx.page, tag)).toEqual([id]);
    await expectStep(ctx, before, { [first.id]: 0 }, 0);
  });

  test('editing the amount recomputes the recoverable split', async () => {
    const ctx = opts.get();
    const r1 = opts.recoverable(opts.firstGross);
    const r2 = opts.recoverable(opts.secondGross);
    await aroundBas(ctx, async () => {
      const before = await snap(ctx.page);
      expectOk(await api(ctx.page).put(`${EXPENSE}/expenses/${id}`, { amountCents: opts.secondGross }), 'edit amount');
      await expectStep(ctx, before, { [first.id]: (opts.secondGross - r2) - (opts.firstGross - r1) }, r2 - r1);
    }, { b1: r2 - r1, g10: 0, g11: opts.secondGross - opts.firstGross });
    const row = (await getExpense(ctx.page, id as string)).data.data;
    expect([row.amountCents, row.recoverableTaxCents]).toEqual([opts.secondGross, r2]);
  });

  test('changing the category moves the net only; 2100 and cash are untouched', async () => {
    const ctx = opts.get();
    const net = opts.secondGross - opts.recoverable(opts.secondGross);
    await aroundBas(ctx, async () => {
      const before = await snap(ctx.page);
      expectOk(await api(ctx.page).put(`${EXPENSE}/expenses/${id}`, { categoryId: second.id }), 'change category');
      await expectStep(ctx, before, { [first.id]: -net, [second.id]: net }, 0);
    }, { b1: 0, g10: 0, g11: 0 });
  });

  test('deleting reverses all three lines', async () => {
    const ctx = opts.get();
    const r2 = opts.recoverable(opts.secondGross);
    await aroundBas(ctx, async () => {
      const before = await snap(ctx.page);
      expectOk(await api(ctx.page).delete(`${EXPENSE}/expenses/${id}`), 'delete typed expense');
      await expectStep(ctx, before, { [second.id]: -(opts.secondGross - r2) }, -r2);
    }, { b1: -r2, g10: 0, g11: -opts.secondGross });
    expect((await getExpense(ctx.page, id as string)).status).toBe(404);
    opts.created.splice(opts.created.indexOf(id as string), 1);
  });
}

/** This run's net effect is zero on every account it touched, and nothing tagged is left. */
async function expectBaseline(ctx: Ctx, tagPrefix: string) {
  expect(await idsByQuery(ctx.page, tagPrefix), 'nothing of this run is left').toHaveLength(0);
  const nonZero = Object.entries(ctx.effect).filter(([, v]) => v !== 0);
  expect(Object.keys(ctx.effect).length, 'the run measured something').toBeGreaterThan(0);
  expect(nonZero, "accounts this run did not return to where it found them").toEqual([]);
}

// ── sydney (AU) ────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('tax codes - sydney (AU)', () => {
  let ctx: Ctx;
  const created: string[] = [];
  const reg = { gstRegistered: true, qstRegistered: null };
  const auRecoverable = (gross: number) =>
    computeLineTax({ jurisdiction: 'au', taxCode: 'GST', amountCents: gross, inclusive: true, registration: reg }).recoverableTaxCents;

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const reason = loginUnavailableReason(testInfo.project.use.baseURL);
    test.skip(reason !== null, reason ?? '');
    ctx = await openPersona(browser, testInfo.project.use.baseURL, 'sydney', true);
  });
  test.afterAll(async () => closePersona(ctx, created));

  test('golden: the engine says $110 incl GST is 1000 recoverable, $220 is 2000', () => {
    expect([auRecoverable(11000), auRecoverable(22000)]).toEqual([1000, 2000]);
  });

  typedLifecycle({
    persona: 'sydney', get: () => ctx, created, taxCode: () => 'GST',
    firstGross: 11000, secondGross: 22000, recoverable: auRecoverable,
    bas: true, // create: 1B +1000 (the golden test pins auRecoverable(11000) === 1000), G11 +11000
  });

  test('mobile Capture: the tax row prefills GST and Save books $110 as 10000 + 1000', async () => {
    test.setTimeout(150_000);
    const { page, t, locale } = ctx;
    const vendor = `${runTag('E2ETAXCAP')} Vendor`;
    const before = await snap(page);
    const basBefore = await bas(page, todayIso());
    await page.goto('/app/capture');
    await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
    await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
    await page.getByLabel(t('mobile.capture.field_amount'), { exact: true }).fill(amountInputText(110, locale));
    await page.getByLabel(t('mobile.capture.field_vendor'), { exact: true }).fill(vendor);
    await expect(page.getByTestId(SEL.capture.taxRow)).toBeVisible();
    await expect(page.getByTestId(SEL.capture.taxCodeGst)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId(SEL.capture.taxModeInclusive)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId(SEL.capture.taxAmount)).toHaveText(
      t('mobile.capture.tax_amount', { tax: money(1000, 'AUD', locale), total: money(11000, 'AUD', locale) }),
    );
    await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
    await expect(page.getByRole('button', { name: t('mobile.capture.snap') })).toBeVisible();
    await expect.poll(async () => (await idsByQuery(page, vendor)).length, { timeout: 20_000 }).toBe(1);
    const [id] = await idsByQuery(page, vendor);
    created.push(id);
    const row = (await getExpense(page, id)).data.data;
    expect([row.amountCents, row.taxCode, row.taxAmountCents, row.recoverableTaxCents]).toEqual([11000, 'GST', 1000, 1000]);
    // The capture save books to whatever category the screen held (suggested or suspense); it moves by the net.
    const acct = await bookedAccount(page, row);
    await expectStep(ctx, before, { [acct]: 10000 }, 1000);
    const basAfter = await bas(page, todayIso());
    const d1B = basAfter.label1BGstOnPurchasesCents - basBefore.label1BGstOnPurchasesCents;
    expect(d1B, 'BAS 1B rose by').toBe(1000);
    track(ctx, 'bas:b1', d1B);
    const del = await snap(page);
    const basDel = await bas(page, todayIso());
    expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete captured expense');
    await expectStep(ctx, del, { [acct]: -10000 }, -1000);
    const dDel = (await bas(page, todayIso())).label1BGstOnPurchasesCents - basDel.label1BGstOnPurchasesCents;
    expect(dDel, 'BAS 1B fell by, across the delete').toBe(-1000);
    track(ctx, 'bas:b1', dDel);
    created.splice(created.indexOf(id), 1);
  });

  test("net effect: this run left sydney's touched accounts and BAS where it found them", async () => {
    test.setTimeout(180_000);
    await expectBaseline(ctx, 'E2ETAX');
  });
});

// ── maya (CA) ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('tax codes - maya (CA)', () => {
  let ctx: Ctx;
  let cfg: TenantCfg;
  const created: string[] = [];
  const recoverable = (gross: number) => computeLineTax({
    jurisdiction: 'ca', region: cfg.region, taxCode: defaultTaxCode('ca', cfg.region), amountCents: gross, inclusive: true,
    registration: { gstRegistered: true, qstRegistered: cfg.qstRegistered },
  }).recoverableTaxCents;

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const reason = loginUnavailableReason(testInfo.project.use.baseURL);
    test.skip(reason !== null, reason ?? '');
    // Read-only: registration comes from the persona seed (fails loudly if missing); her region is never changed.
    ctx = await openPersona(browser, testInfo.project.use.baseURL, 'maya', true);
    cfg = await tenantConfig(ctx.page);
  });
  test.afterAll(async () => closePersona(ctx, created));

  test('golden: hand values for the province (ON HST 13%) and QST via the engine when she is not in QC', () => {
    if (cfg.region === 'ON') {
      expect(defaultTaxCode('ca', 'ON')).toBe('HST');
      expect(recoverable(11300)).toBe(1300);
    }
    if (cfg.region !== 'QC') {
      // Not in QC: QST is proved by the engine only (her region stays as it is). 5% GST + 9.975% QST on $100.
      const qc = (qst: boolean | null) => computeLineTax({
        jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 11498, inclusive: true,
        registration: { gstRegistered: true, qstRegistered: qst },
      }).recoverableTaxCents;
      expect([qc(true), qc(null)]).toEqual([1498, 500]);
    }
  });

  typedLifecycle({
    persona: 'maya', get: () => ctx, created, taxCode: () => defaultTaxCode('ca', cfg.region),
    firstGross: 11300, secondGross: 22600, recoverable,
  });

  test('the tax-codes preview matches the engine for her default code', async () => {
    const res = await api(ctx.page).get(`${EXPENSE}/tax-codes?amountCents=11300&inclusive=true`);
    expectOk(res, 'tax-codes preview');
    const v = res.data.data;
    const e = computeLineTax({
      jurisdiction: 'ca', region: cfg.region, taxCode: defaultTaxCode('ca', cfg.region), amountCents: 11300, inclusive: true,
      registration: { gstRegistered: true, qstRegistered: cfg.qstRegistered },
    });
    expect([v.visible, v.defaultCode, v.preview?.taxCents, v.preview?.netCents]).toEqual([true, defaultTaxCode('ca', cfg.region), e.taxCents, e.netCents]);
  });

  test("net effect: this run left maya's touched accounts where it found them", async () => {
    test.setTimeout(180_000);
    await expectBaseline(ctx, 'E2ETAX');
  });
});

// ── alex (US) ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('tax codes - alex (US)', () => {
  let ctx: Ctx;
  const created: string[] = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const reason = loginUnavailableReason(testInfo.project.use.baseURL);
    test.skip(reason !== null, reason ?? '');
    ctx = await openPersona(browser, testInfo.project.use.baseURL, 'alex', false);
  });
  test.afterAll(async () => closePersona(ctx, created));

  test('the server says no tax row for a US tenant', async () => {
    const res = await api(ctx.page).get(`${EXPENSE}/tax-codes?amountCents=12345&inclusive=true`);
    expectOk(res, 'tax-codes');
    expect([res.data.data.visible, res.data.data.preview]).toEqual([false, null]);
  });

  test('mobile Capture shows no tax row and Save posts the gross on 2 lines', async () => {
    test.setTimeout(150_000);
    const { page, t, locale } = ctx;
    const vendor = `${runTag('E2ETAXUS')} Vendor`;
    const before = await snap(page);
    await page.goto('/app/capture');
    await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
    await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
    const tax = page.waitForResponse((r) => new URL(r.url()).pathname === `${EXPENSE}/tax-codes`, { timeout: 15_000 });
    await page.getByLabel(t('mobile.capture.field_amount'), { exact: true }).fill(amountInputText(123.45, locale));
    await page.getByLabel(t('mobile.capture.field_vendor'), { exact: true }).fill(vendor);
    await tax; // the row's data has arrived; absence below is the rendered answer, not a race
    await expect(page.getByTestId(SEL.capture.taxRow)).toHaveCount(0);
    await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
    await expect(page.getByRole('button', { name: t('mobile.capture.snap') })).toBeVisible();
    await expect.poll(async () => (await idsByQuery(page, vendor)).length, { timeout: 20_000 }).toBe(1);
    const [id] = await idsByQuery(page, vendor);
    created.push(id);
    const row = (await getExpense(page, id)).data.data;
    expect([row.amountCents, row.recoverableTaxCents ?? 0]).toEqual([12345, 0]);
    const acct = await bookedAccount(page, row);
    await expectStep(ctx, before, { [acct]: 12345 }, 0);
    const del = await snap(page);
    expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete');
    await expectStep(ctx, del, { [acct]: -12345 }, 0);
    created.splice(created.indexOf(id), 1);
  });

  test("net effect: this run left alex's touched accounts where it found them", async () => {
    await expectBaseline(ctx, 'E2ETAX');
  });
});
