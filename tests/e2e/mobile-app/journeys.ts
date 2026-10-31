import { expect, type Locator, type Page } from '@playwright/test';
import type { MobileHome } from '../../../apps/web-next/src/lib/mobile/types';
import { catalogT, pageLocales, type CatalogT } from './helpers';
import { SEL } from './selectors';
import { inPageFetch } from './page-api';
// personas.ts (assertions per persona), NOT helpers.ts's PERSONAS (login credentials).
import { PERSONAS, digits, wholeUnits, type PersonaKey } from './personas';
import { forceLocale, catalogValues, commonValue } from './locale';
import {
  PERSONA_CURRENCY,
  amountInputText,
  countByQuery,
  createExpense,
  deleteExpenseQuietly,
  getExpense,
  listFilter,
  randomWholeDollars,
  todayIso,
  totalsSnapshot,
  diffTotals,
  type Collected,
  type Persona,
} from './fixtures';

/**
 * The persona x journey matrix (spec 8.1(7) x 8.2). Each journey is `(page, persona, ctx?)`.
 *
 * Ground rules (each one earned by a failed run in an earlier PR):
 *  - UI strings come from the catalog and are PROVEN against the page (`proveLocale`); no English literal is asserted.
 *  - Anything that mutates operates on a fixture the journey creates (tagged, dated today) and deletes in `finally`.
 *    Seeded data is only ever read. Chat "Proceed" is never clicked (it edits the persona's latest expense).
 *  - Locators are lazy, so "the new one" is pinned by index and screens are awaited before reading "loading is gone".
 */

export interface JourneyCtx {
  /** The error collector (fixtures.ts), for the two journeys that DELIBERATELY provoke a 404. */
  errors?: Collected;
  /** This persona's run tag: every fixture a journey makes carries it in its vendor. */
  tag: string;
  /** Ids of fixtures created, so the describe-level sweep can remove stragglers. */
  created: string[];
}

const SAFE_FALLBACK = /I don't want to quote you a number/i;
const FILTERS = ['needs-review', 'no-category', 'no-receipt', 'all', 'archived'] as const;

async function getHome(page: Page): Promise<MobileHome> {
  const r = await inPageFetch<{ success: boolean; data: MobileHome }>(page, 'GET', '/api/v1/agentbook-core/mobile/home');
  expect(r.status, 'mobile/home').toBe(200);
  return r.data!.data;
}

/** The text a locator shows, whether it is an <input> (value) or plain text. */
async function shownText(el: Locator): Promise<string> {
  return el.evaluate((n) => (n as HTMLInputElement).value || n.textContent || '');
}

/**
 * Jurisdiction check. `forbiddenTerms` (foreign tax regimes) are checked against the whole screen.
 * `wrongCurrencyMarks` are checked ONLY against the aggregate regions passed in (Home KPI strip / alert banner, Docs
 * results header), never against individual expense rows: Maya's SEEDED expenses are USD rows on a CAD tenant and the
 * app displays them in the tenant currency (a USD 25 row reads "CA$25"). That is a known display limitation, recorded in
 * the launch scorecard and deliberately NOT fixed or asserted here.
 */
async function assertJurisdictionClean(page: Page, persona: PersonaKey, aggregates: Locator[] = []) {
  const body = await page.locator('body').innerText();
  for (const re of PERSONAS[persona].forbiddenTerms) expect(body, `foreign jurisdiction term ${re}`).not.toMatch(re);
  for (const region of aggregates) {
    if ((await region.count()) === 0) continue;
    const text = (await region.allInnerTexts()).join('\n');
    for (const re of PERSONAS[persona].wrongCurrencyMarks) expect(text, `wrong currency mark ${re} in an aggregate region`).not.toMatch(re);
  }
}

function screenFor(route: string): string {
  const path = route.split('?')[0];
  if (path.startsWith('/app/docs/')) return SEL.viewer.screen;
  if (path.startsWith('/app/docs')) return SEL.docs.screen;
  if (path.startsWith('/app/capture')) return SEL.capture.screen;
  if (path.startsWith('/app/chat')) return SEL.chat.screen;
  return SEL.home.screen;
}

async function firstDocId(page: Page): Promise<string | null> {
  const r = await inPageFetch<{ data: Array<{ id: string }> }>(page, 'GET', '/api/v1/agentbook-expense/expenses?limit=1');
  return r.data?.data?.[0]?.id ?? null;
}

/**
 * Land on an /app route, read the page's string locale, and PROVE the catalog matches what is rendered by finding the
 * screen's catalog title on the page. Without the proof, `t` silently falls back to English for a French tenant.
 */
export async function proveLocale(page: Page, route: '/app/capture' | '/app/docs' | '/app/chat'): Promise<{ t: CatalogT; formatLocale: string }> {
  await page.goto(route);
  await expect(page.getByTestId(screenFor(route))).toBeVisible();
  const loc = await pageLocales(page);
  const t = catalogT(loc.stringLocale);
  const title = route === '/app/docs' ? t('common.documents') : t(`mobile.${route.slice('/app/'.length)}.title`);
  await expect(page.getByRole('heading', { name: title }), 'catalog locale does not match the rendered page').toBeVisible();
  return { t, formatLocale: loc.formatLocale };
}

/** Drop the browser's own "Failed to load resource" lines for a request WE deliberately made fail (a 404 probe). */
function forgiveProbe(ctx: JourneyCtx | undefined) {
  if (!ctx?.errors) return;
  const keep = ctx.errors.console.filter((m) => !/Failed to load resource/i.test(m));
  ctx.errors.console.splice(0, ctx.errors.console.length, ...keep);
}

/**
 * Narrower than forgiveProbe: drop only 404 lines. For the one 404 a journey provokes on purpose (asserting that a
 * fixture it deleted is really gone, via an in-page fetch the browser logs); any other failing request still fails.
 */
function forgive404(ctx: JourneyCtx | undefined) {
  if (!ctx?.errors) return;
  const keep = ctx.errors.console.filter((m) => !/Failed to load resource: the server responded with a status of 404/.test(m));
  ctx.errors.console.splice(0, ctx.errors.console.length, ...keep);
}

export async function home(page: Page, persona: PersonaKey) {
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  const h = await getHome(page);
  if (!PERSONAS[persona].seeded) {
    expect(h.isBrandNew).toBe(true);
    await expect(page.getByTestId(SEL.home.empty)).toBeVisible();
    return;
  }
  expect(h.currency).toBe(PERSONAS[persona].currency);
  await expect(page.getByTestId(SEL.home.empty)).toHaveCount(0);
  const tiles: Array<[string, number | null]> = [
    [SEL.home.kpiMonthNet, h.kpis.monthNetCents],
    [SEL.home.kpiCash, h.kpis.cashTodayCents],
    [SEL.home.kpiOutstanding, h.kpis.outstandingCents],
    [SEL.home.kpiTax, h.kpis.estTaxOwedCents],
  ];
  for (const [id, cents] of tiles) {
    const tile = page.getByTestId(id);
    await expect(tile).toBeVisible();
    if (cents !== null) await expect.poll(async () => digits(await tile.innerText()), { message: id }).toContain(wholeUnits(cents));
  }
  for (const a of h.alerts) if (a.target) expect(a.target.route.startsWith('/app'), a.kind).toBe(true);
  if (h.alerts.length > 0) await expect(page.getByTestId(SEL.home.alertBanner)).toBeVisible();
  else await expect(page.getByTestId(SEL.home.alertBanner)).toHaveCount(0);
  await assertJurisdictionClean(page, persona, [
    page.getByTestId(SEL.home.kpiMonthNet),
    page.getByTestId(SEL.home.kpiCash),
    page.getByTestId(SEL.home.kpiOutstanding),
    page.getByTestId(SEL.home.kpiTax),
    page.getByTestId(SEL.home.alertBanner),
  ]);
}

export async function alertActions(page: Page, persona: PersonaKey) {
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  const h = await getHome(page);
  if (!PERSONAS[persona].seeded) {
    expect(h.alerts).toEqual([]);
    return;
  }
  // Every navigational alert lands on a working mobile screen. POST actions (e.g. Remind) are NOT clicked:
  // they email real recipients.
  for (const a of h.alerts.filter((x) => x.target)) {
    const qs = a.target!.query ? `?${new URLSearchParams(a.target!.query)}` : '';
    await page.goto(`${a.target!.route}${qs}`);
    await expect(page.getByTestId(screenFor(a.target!.route)), a.kind).toBeVisible();
    await expect(page.locator('[data-testid$="-error"]'), `${a.kind}: error state`).toHaveCount(0);
  }
  // The banner shows alert[0]. It renders a link (home-alert-action) only when the alert has a target and NO POST action;
  // an alert with a POST action renders a button instead (Remind), which this journey never clicks.
  const top = h.alerts[0];
  if (top?.target && !top.action) {
    await page.goto('/app');
    await expect(page.getByTestId(SEL.home.alertBanner)).toBeVisible();
    await page.getByTestId(SEL.home.alertAction).first().click();
    await expect(page.getByTestId(screenFor(top.target.route))).toBeVisible();
    expect(new URL(page.url()).pathname.startsWith(top.target.route.split('?')[0])).toBe(true);
  }
}

export async function docs(page: Page, persona: PersonaKey) {
  await page.goto('/app/docs');
  await expect(page.getByTestId(SEL.docs.screen)).toBeVisible();
  const rows = page.getByTestId(SEL.docs.row);
  const idOf = async (row: Locator) => decodeURIComponent(((await row.getAttribute('href')) ?? '').split('/').pop() ?? '');
  for (const f of FILTERS) {
    const chip = page.getByTestId(`${SEL.docs.filterPrefix}${f}`);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // The truth is the list route for the same chip (the server builds both from one table).
    const truth = await listFilter(page, f);
    if (truth.total === 0 || !PERSONAS[persona].seeded) {
      await expect(page.getByTestId(SEL.docs.empty), `${f}: empty state`).toBeVisible();
      await expect(rows, `${f}: no rows`).toHaveCount(0);
    } else {
      const ids = new Set(truth.rows.map((r) => r.id));
      await expect(rows.first(), `${f}: has rows`).toBeVisible();
      await expect(page.getByTestId(SEL.docs.empty)).toHaveCount(0);
      // Poll: right after a chip switch the previous list can still be on screen for a frame.
      await expect.poll(async () => ids.has(await idOf(rows.first())), { message: `${f}: first row belongs to the filter` }).toBe(true);
    }
    await expect(page.getByTestId(SEL.docs.error)).toHaveCount(0);
  }
  if (!PERSONAS[persona].seeded) return;
  await page.getByTestId(`${SEL.docs.filterPrefix}all`).click();
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId(SEL.viewer.screen)).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const row = await inPageFetch<{ data: { amountCents: number } }>(page, 'GET', `/api/v1/agentbook-expense/expenses/${id}`);
  expect(row.status).toBe(200);
  const cents = Math.abs(row.data!.data.amountCents);
  const amountEl = page.getByTestId(SEL.viewer.amount);
  await expect(amountEl).toBeVisible();
  // Whole-unit formatting rounds; accept the rounded or the floored figure (a 12.50 row may read 13 or 12), and decimals.
  await expect
    .poll(async () => {
      const d = digits(await shownText(amountEl));
      return [wholeUnits(cents), String(Math.floor(cents / 100)), String(cents)].some((w) => d.includes(w));
    }, { message: 'viewer amount shows the stored amount' })
    .toBe(true);
  await assertJurisdictionClean(page, persona);
}

/**
 * Archive -> Archived -> restore, on a fixture THIS journey creates (never a seeded row). The brand-new account has no
 * books to archive from, so it runs the not-found branch of the viewer instead.
 */
export async function archiveRoundTrip(page: Page, persona: PersonaKey, ctx?: JourneyCtx) {
  if (!PERSONAS[persona].seeded) {
    await page.goto('/app/docs/does-not-exist');
    await expect(page.getByTestId(SEL.viewer.error)).toBeVisible();
    forgiveProbe(ctx); // the 404 was provoked on purpose
    return;
  }
  const tag = ctx!.tag;
  const key = persona as Persona;
  await page.goto('/app/docs');
  await expect(page.getByTestId(SEL.docs.screen)).toBeVisible();
  const vendor = `${tag} Archive`;
  const id = await createExpense(page, {
    amountCents: randomWholeDollars() * 100, vendor, description: vendor.toLowerCase(), date: todayIso(), currency: PERSONA_CURRENCY[key], isPersonal: false,
  });
  ctx!.created.push(id);
  try {
    // Totals AFTER the fixture exists: archive/restore must not move any of them.
    const before = await totalsSnapshot(page);
    await page.goto(`/app/docs/${id}`);
    await expect(page.getByTestId(SEL.viewer.screen)).toBeVisible();
    // By design (PR 4) an UNCATEGORIZED document with no AI pick opens the category picker on arrival, once the pick
    // check has finished. The fixture is uncategorized, so the picker covers the Archive button (a pointer-intercepting
    // sheet, which is what failed here) until the user dismisses it. Do what a user does; tolerate the case where an AI
    // suggestion arrived instead and the picker never opened.
    const picker = page.getByRole('dialog');
    if (await picker.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)) {
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
    }
    await page.getByTestId(SEL.viewer.archive).click();
    await expect(page.getByTestId(SEL.viewer.restore)).toBeVisible();
    await expect.poll(async () => (await getExpense(page, id)).data.data.archivedAt, { timeout: 20_000 }).not.toBeNull();
    expect((await listFilter(page, 'archived', { q: tag })).rows.map((r) => r.id), 'under Archived').toContain(id);
    expect(await countByQuery(page, tag), 'hidden from the default list').toBe(0);
    expect(diffTotals(before, await totalsSnapshot(page)), 'archive must not move any total').toEqual([]);

    await page.goto(`/app/docs?filter=archived&q=${encodeURIComponent(tag)}`);
    await expect(page.getByTestId(SEL.docs.row).filter({ hasText: vendor })).toHaveCount(1);

    await page.goto(`/app/docs/${id}`);
    await page.getByTestId(SEL.viewer.restore).click();
    await expect(page.getByTestId(SEL.viewer.archive)).toBeVisible();
    await expect.poll(async () => (await getExpense(page, id)).data.data.archivedAt, { timeout: 20_000 }).toBeNull();
    expect((await listFilter(page, 'archived', { q: tag })).rows.map((r) => r.id), 'out of Archived').not.toContain(id);
    expect(diffTotals(before, await totalsSnapshot(page)), 'restore must not move any total').toEqual([]);
  } finally {
    // Leave the viewer BEFORE deleting its document: a page that is still open on it refetches and logs a 404.
    await page.goto('/app/docs', { waitUntil: 'commit' }).catch(() => undefined);
    await deleteExpenseQuietly(page, id);
  }
  expect((await getExpense(page, id)).status, 'fixture removed').toBe(404);
  forgive404(ctx); // that 404 was the assertion
}

/**
 * Capture by MANUAL entry (deterministic; the photo + OCR + offline paths have their own journeys in capture.spec.ts).
 * Books one tagged expense in the tenant currency, finds it in Docs, and deletes it in `finally`.
 */
export async function capture(page: Page, persona: PersonaKey, ctx?: JourneyCtx) {
  const { t, formatLocale } = await proveLocale(page, '/app/capture');
  const vendor = `${ctx!.tag} Capture`;
  const dollars = randomWholeDollars();
  const field = (key: 'mobile.capture.field_amount' | 'mobile.capture.field_vendor') => page.getByLabel(t(key), { exact: true });
  try {
    await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
    await field('mobile.capture.field_amount').fill(amountInputText(dollars, formatLocale));
    await field('mobile.capture.field_vendor').fill(vendor);
    await page.getByRole('button', { name: t('mobile.capture.save'), exact: true }).click();
    await expect(page.getByRole('button', { name: t('mobile.capture.snap') })).toBeVisible(); // back on the camera-ready screen
    await expect.poll(() => countByQuery(page, vendor), { timeout: 20_000 }).toBe(1);
    const list = await inPageFetch<{ data: Array<{ id: string }> }>(page, 'GET', `/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(vendor)}&limit=100`);
    for (const r of list.data?.data ?? []) if (!ctx!.created.includes(r.id)) ctx!.created.push(r.id);
    const id = list.data!.data[0].id;
    const one = await getExpense(page, id);
    expect(one.data.data.amountCents).toBe(dollars * 100);
    if (PERSONAS[persona].currency) expect(one.data.data.currency, 'booked in the tenant currency, not the USD default').toBe(PERSONAS[persona].currency);
    await page.goto(`/app/docs/${id}`);
    await expect(page.getByTestId(SEL.viewer.screen)).toBeVisible();
    await expect.poll(async () => digits(await shownText(page.getByTestId(SEL.viewer.amount)))).toContain(String(dollars));
  } finally {
    // Sweep this journey's own tag so a failed assertion cannot leave the expense behind.
    const l = await inPageFetch<{ data: Array<{ id: string }> }>(page, 'GET', `/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(vendor)}&limit=100`).catch(() => null);
    for (const r of l?.data?.data ?? []) await deleteExpenseQuietly(page, r.id);
  }
}

export async function chat(page: Page, persona: PersonaKey) {
  await page.goto('/app/chat');
  await expect(page.getByTestId(SEL.chat.screen)).toBeVisible();
  await expect(page.getByTestId(SEL.chat.loading)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId(SEL.chat.error)).toHaveCount(0);
  if (!PERSONAS[persona].seeded) await expect(page.getByTestId(SEL.chat.empty)).toBeVisible();
  const bots = page.getByTestId(SEL.chat.botBubble);
  const before = await bots.count();
  await page.getByTestId(SEL.chat.input).fill('hello');
  await page.getByTestId(SEL.chat.send).click();
  await expect(bots).toHaveCount(before + 1, { timeout: 90_000 });
  // Pinned by index: `.last()` is lazy and would move when a later reply arrives.
  const reply = bots.nth(before);
  await expect(reply).not.toHaveText('');
  const text = (await reply.textContent()) ?? '';
  expect(text).not.toMatch(SAFE_FALLBACK);
  await assertJurisdictionClean(page, persona);
}

export async function tabs(page: Page) {
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __e2eNoReload: number }).__e2eNoReload = 42; });
  const steps: Array<[string, string, string]> = [
    [SEL.shell.tabDocs, '/app/docs', SEL.docs.screen],
    [SEL.shell.tabCapture, '/app/capture', SEL.capture.screen],
    [SEL.shell.tabChat, '/app/chat', SEL.chat.screen],
    [SEL.shell.tabHome, '/app', SEL.home.screen],
  ];
  for (const [tab, path, screenId] of steps) {
    await page.getByTestId(tab).click();
    await expect(page.getByTestId(screenId)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    expect(await page.evaluate(() => (window as unknown as { __e2eNoReload?: number }).__e2eNoReload), `${tab}: full reload happened`).toBe(42);
  }
}

export async function deepLinks(page: Page, persona: PersonaKey, ctx?: JourneyCtx) {
  await page.goto('/app/docs?filter=no-receipt');
  await expect(page.getByTestId(`${SEL.docs.filterPrefix}no-receipt`)).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/app/chat');
  await expect(page.getByTestId(SEL.chat.screen)).toBeVisible();
  await page.goto('/app/capture');
  await expect(page.getByTestId(SEL.capture.screen)).toBeVisible();
  if (PERSONAS[persona].seeded) {
    await page.goto('/app');
    const id = await firstDocId(page);
    expect(id, 'seeded persona has at least one expense').toBeTruthy();
    await page.goto(`/app/docs/${id}`);
    await expect(page.getByTestId(SEL.viewer.screen)).toBeVisible();
  }
  // The not-found page is the app-wide English one (not catalog copy), so assert the status / the 404 code only.
  const res = await page.goto('/app/this-route-does-not-exist');
  const body = await page.locator('body').innerText();
  expect(res?.status() === 404 || /404/.test(body), 'unknown /app route shows not-found').toBe(true);
  forgiveProbe(ctx); // the 404 was provoked on purpose
}

export async function languageSwitch(page: Page) {
  // The tenant-config GET is rewritten and the switcher's PUT answered locally: nothing in production is mutated.
  await forceLocale(page, 'en');
  await page.goto('/app');
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  const en = catalogValues('en');
  const fr = catalogValues('fr-CA');
  await expect(page.getByTestId(SEL.shell.tabHome), 'English forced').toContainText(en['mobile.tabs.home']);

  await page.getByRole('button', { name: commonValue('en', 'change_language') }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('menuitemradio', { name: /Fran/ }).click()]);
  await expect(page.locator('html')).toHaveAttribute('lang', /^fr/);
  await expect(page.getByTestId(SEL.home.screen)).toBeVisible();
  // The locale pack is a lazy chunk: the tab label turns French once it lands.
  await expect(page.getByTestId(SEL.shell.tabHome), 'French strings after switching').toContainText(fr['mobile.tabs.home']);
  await expect(page.getByTestId(SEL.shell.tabDocs)).toContainText(fr['mobile.tabs.docs']);

  // The second click is found by its French accessible name, from the catalog (the UI is French now).
  await page.getByRole('button', { name: commonValue('fr-CA', 'change_language') }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('menuitemradio', { name: /English/ }).click()]);
  await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
  await expect(page.getByTestId(SEL.shell.tabHome), 'English strings after switching back').toContainText(en['mobile.tabs.home']);
}
