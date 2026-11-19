import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, money, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import {
  PERSONA_CURRENCY,
  amountInputText,
  deleteExpenseQuietly,
  diffTotals,
  getExpense,
  listCategoryAccounts,
  movedAccounts,
  pnlSnapshot,
  runTag,
  todayIso,
  totalsSnapshot,
  type ExpenseAccount,
  type Persona,
  type PnlSnapshot,
  type Totals,
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
 * Fixtures are tagged, dated today (UTC), created and deleted by the test; seeded data is never touched. Every
 * persona's books (P&L, estimate, Home KPIs, 2100 and, for AU, the BAS) end where they started.
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
  baseline: Totals;
  baseTb: Tb;
  /** Value to put back in afterAll when the test had to set the registration flag; undefined = untouched. */
  restoreGst: boolean | null | undefined;
}

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
  let restoreGst: boolean | null | undefined;
  if (needRegistered) {
    // NEVER a permanent persona change: read the flag first; only if it is not already true is it set for this
    // run, and afterAll puts the original value (true/false/null) back.
    const cfg = await tenantConfig(page);
    if (cfg.gstRegistered !== true) {
      restoreGst = cfg.gstRegistered;
      expectOk(await api(page).put(`${CORE}/tenant-config`, { gstRegistered: true }), 'set gstRegistered for the run');
    }
  }
  return { context, page, t, locale: loc.formatLocale, baseline: await totalsSnapshot(page), baseTb: await trialBalance(page), restoreGst };
}

async function closePersona(ctx: Ctx | undefined, created: string[]) {
  if (!ctx) return;
  for (const id of created) await deleteExpenseQuietly(ctx.page, id);
  if (ctx.restoreGst !== undefined) {
    await api(ctx.page).put(`${CORE}/tenant-config`, { gstRegistered: ctx.restoreGst }).catch(() => undefined);
  }
  await ctx.context.close();
}

/** One step of the typed lifecycle: the P&L moved exactly by `pnl`, 2100 by `gst`, and the books still balance. */
async function expectStep(page: Page, before: { pnl: PnlSnapshot; tb: Tb }, pnl: Record<string, number>, gst: number) {
  const after = { pnl: await pnlSnapshot(page), tb: await trialBalance(page) };
  expect(movedAccounts(before.pnl, after.pnl), 'P&L movement by account').toEqual(pnl);
  expect(tbDelta(before.tb, after.tb, '2100'), '2100 GST control moved by').toBe(gst);
  const gross = Object.values(pnl).reduce((s, v) => s + v, 0) + gst;
  expect(tbDelta(before.tb, after.tb, '1000'), 'cash credited by the gross').toBe(-gross);
  expect(after.tb.balanced, 'trial balance balances').toBe(true);
  return after;
}
const snap = async (page: Page) => ({ pnl: await pnlSnapshot(page), tb: await trialBalance(page) });

/**
 * The typed lifecycle shared by AU and CA: create (with an idempotency key, then replayed), edit amount, change
 * category, delete. `split(gross)` is the engine's expected recoverable tax for a gross amount.
 */
function typedLifecycle(opts: {
  persona: Persona;
  get: () => Ctx;
  created: string[];
  taxCode: () => string;
  firstGross: number;
  secondGross: number;
  recoverable: (gross: number) => number;
  onBas?: (deltaRecoverable: number, deltaGross: number, before: Bas, after: Bas) => void;
}) {
  const tag = runTag(`E2ETAX${opts.persona.slice(0, 2).toUpperCase()}`);
  let first: ExpenseAccount;
  let second: ExpenseAccount;
  let id: string | null = null;
  const key = crypto.randomUUID();
  const date = todayIso();
  let body: Record<string, unknown>;
  let basBefore: Bas | null = null;

  test('typed create books the net on the category and the recoverable tax on 2100', async () => {
    const { page } = opts.get();
    [first, second] = await plainCategories(page);
    const before = await snap(page);
    if (opts.onBas) basBefore = await bas(page, date);
    body = {
      amountCents: opts.firstGross, taxCode: opts.taxCode(), taxInclusive: true, date,
      vendor: `${tag} Vendor`, description: `${tag} typed`, currency: PERSONA_CURRENCY[opts.persona],
      categoryId: first.id, categorySource: 'user',
    };
    const res = await postExpenseWithKey(page, key, body);
    expectOk(res, 'create typed expense');
    id = res.data.data.id as string;
    opts.created.push(id);
    const rec = opts.recoverable(opts.firstGross);
    expect(rec, 'the engine credits some tax for a registrant').toBeGreaterThan(0);
    const row = (await getExpense(page, id)).data.data;
    expect([row.amountCents, row.taxCode, row.recoverableTaxCents]).toEqual([opts.firstGross, opts.taxCode(), rec]);
    await expectStep(page, before, { [first.id]: opts.firstGross - rec }, rec);
    if (opts.onBas && basBefore) opts.onBas(rec, opts.firstGross, basBefore, await bas(page, date));
  });

  test('replaying the same idempotency key is still one expense and moves nothing', async () => {
    const { page } = opts.get();
    const before = await snap(page);
    const res = await postExpenseWithKey(page, key, body);
    expectOk(res, 'replay typed expense');
    expect(res.data.data.id, 'replay returns the original').toBe(id);
    expect(await idsByQuery(page, tag)).toEqual([id]);
    await expectStep(page, before, {}, 0);
  });

  test('editing the amount recomputes the recoverable split', async () => {
    const { page } = opts.get();
    const before = await snap(page);
    expectOk(await api(page).put(`${EXPENSE}/expenses/${id}`, { amountCents: opts.secondGross }), 'edit amount');
    const r1 = opts.recoverable(opts.firstGross);
    const r2 = opts.recoverable(opts.secondGross);
    const row = (await getExpense(page, id as string)).data.data;
    expect([row.amountCents, row.recoverableTaxCents]).toEqual([opts.secondGross, r2]);
    await expectStep(page, before, { [first.id]: (opts.secondGross - r2) - (opts.firstGross - r1) }, r2 - r1);
  });

  test('changing the category moves the net only; 2100 is untouched', async () => {
    const { page } = opts.get();
    const before = await snap(page);
    expectOk(await api(page).put(`${EXPENSE}/expenses/${id}`, { categoryId: second.id }), 'change category');
    const net = opts.secondGross - opts.recoverable(opts.secondGross);
    const after = { pnl: await pnlSnapshot(page), tb: await trialBalance(page) };
    expect(movedAccounts(before.pnl, after.pnl)).toEqual({ [first.id]: -net, [second.id]: net });
    expect(tbDelta(before.tb, after.tb, '2100')).toBe(0);
    expect(tbDelta(before.tb, after.tb, '1000')).toBe(0);
    expect(after.tb.balanced).toBe(true);
  });

  test('deleting reverses all three lines', async () => {
    const { page } = opts.get();
    const before = await snap(page);
    expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete typed expense');
    const r2 = opts.recoverable(opts.secondGross);
    await expectStep(page, before, { [second.id]: -(opts.secondGross - r2) }, -r2);
    expect((await getExpense(page, id as string)).status).toBe(404);
    if (opts.onBas && basBefore) {
      const now = await bas(page, date);
      expect([now.label1BGstOnPurchasesCents, now.g10CapitalPurchasesCents, now.g11NonCapitalPurchasesCents], 'BAS back to its start')
        .toEqual([basBefore.label1BGstOnPurchasesCents, basBefore.g10CapitalPurchasesCents, basBefore.g11NonCapitalPurchasesCents]);
    }
  });
}

/** Back to baseline: nothing tagged is left and every headline figure (and the trial balance) is where it began. */
async function expectBaseline(ctx: Ctx, tagPrefix: string) {
  expect(await idsByQuery(ctx.page, tagPrefix), 'nothing of this run is left').toHaveLength(0);
  expect(diffTotals(ctx.baseline, await totalsSnapshot(ctx.page)), 'fields that did not return to their start').toEqual([]);
  const tb = await trialBalance(ctx.page);
  for (const code of ['1000', '2100']) expect(tbDelta(ctx.baseTb, tb, code), `${code} back to baseline`).toBe(0);
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
    onBas: (rec, gross, before, after) => {
      expect(rec).toBe(1000);
      expect(after.label1BGstOnPurchasesCents - before.label1BGstOnPurchasesCents, 'BAS 1B rose by').toBe(1000);
      expect(after.g11NonCapitalPurchasesCents - before.g11NonCapitalPurchasesCents, 'BAS G11 rose by the gross').toBe(gross);
      expect(after.g10CapitalPurchasesCents - before.g10CapitalPurchasesCents, 'BAS G10 unchanged').toBe(0);
    },
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
    const booked = await expectStep(page, before, { [row.categoryId as string]: 10000 }, 1000);
    void booked;
    const basAfter = await bas(page, todayIso());
    expect(basAfter.label1BGstOnPurchasesCents - basBefore.label1BGstOnPurchasesCents, 'BAS 1B rose by').toBe(1000);
    const del = await snap(page);
    expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete captured expense');
    await expectStep(page, del, { [row.categoryId as string]: -10000 }, -1000);
    created.splice(created.indexOf(id), 1);
  });

  test("totals invariant: sydney's books and BAS are where they started", async () => {
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
    // Registration is set for the run only if needed and restored in afterAll; her region is never changed.
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

  test("totals invariant: maya's books are where they started", async () => {
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
    await expectStep(page, before, { [row.categoryId as string]: 12345 }, 0);
    const del = await snap(page);
    expectOk(await api(page).delete(`${EXPENSE}/expenses/${id}`), 'delete');
    await expectStep(page, del, { [row.categoryId as string]: -12345 }, 0);
    created.splice(created.indexOf(id), 1);
  });

  test("totals invariant: alex's books are where they started", async () => {
    await expectBaseline(ctx, 'E2ETAX');
  });
});
