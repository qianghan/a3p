import type { Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { randomBytes, randomInt } from 'node:crypto';
import { api, expectOk } from '../nightly/helpers/api';
import { PERSONAS, money, type Persona as AnyPersona } from './helpers';
// Dependency-free (types only): the SAME chip -> query-param table the server builds its counts from.
import { DOC_FILTER_PARAMS } from '../../../apps/web-next/src/lib/mobile/doc-filters';
import type { DocCounts, DocFilter } from '../../../apps/web-next/src/lib/mobile/types';

/**
 * Fixtures for the mobile e2e journeys (PR 4 Docs; PR 5 reuses the record helpers).
 *
 * The pure functions here (tags, amounts, money matching, ledger arithmetic) are unit-tested in
 * fixtures.spec.ts with no browser and no network. Everything that talks to the deployment goes
 * through the nightly `api()` client: an in-page fetch, so the httpOnly session cookie is sent.
 */

/** The seeded personas (never the throwaway 'fresh' account: it has no books to measure). */
export type Persona = Exclude<AnyPersona, 'fresh'>;

/** Derived from the ONE persona table in helpers.ts, never a second copy. */
export const PERSONA_CURRENCY: Readonly<Record<Persona, string>> = Object.freeze(
  Object.fromEntries((Object.keys(PERSONAS) as Persona[]).map((p) => [p, PERSONAS[p].currency])) as Record<Persona, string>,
);

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';
const TAX = '/api/v1/agentbook-tax';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * A unique, search-safe, upper-case tag (`E2EDOCMA` + time + CSPRNG hex). It is put in the vendor and the
 * description of every fixture so `?q=<tag>` finds exactly this run's records and nothing else, and so a
 * leftover from a crashed run is recognisable. `now` and `entropy` are injectable for the tests.
 */
export function runTag(prefix: string, now: number = Date.now(), entropy: string = randomBytes(3).toString('hex')): string {
  return `${prefix}${now.toString(36)}${entropy}`.toUpperCase();
}

export const MIN_DOLLARS = 101;
export const MAX_DOLLARS = 900;

/**
 * Whole dollars, 101..900 inclusive. formatCurrencyCents drops the cents (maximumFractionDigits 0), so a
 * fixture with cents would render as a different number than the one typed; and >100 keeps it above the
 * Home "missing receipt" threshold (> $25) so it is visible to every predicate. `pick(min, maxExclusive)`
 * is injectable for the tests.
 */
export function randomWholeDollars(pick: (min: number, maxExclusive: number) => number = randomInt): number {
  return pick(MIN_DOLLARS, MAX_DOLLARS + 1);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The UTC calendar date (YYYY-MM-DD) the server stores a dated record under. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/** `iso` (YYYY-MM-DD) moved by `days`, in UTC. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return todayIso(d);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex for a catalog sentence that has one runtime-dependent part. Render the sentence with `token` standing in
 * for that part (e.g. the clock time), and every other character is matched literally:
 * `placeholderRegex(t('mobile.docs.offline_snapshot', { time: TOKEN }), TOKEN)`.
 */
export function placeholderRegex(renderedWithToken: string, token: string): RegExp {
  return new RegExp(`^${escapeRegExp(renderedWithToken).split(escapeRegExp(token)).join('.+')}$`);
}

/**
 * Matches `dollars` rendered by the APP'S OWN formatter (the same function the screens call, imported from
 * source) in the page's formatting locale: the whole figure, not a longer number it is a prefix of
 * ("$34" must not match "$347") and not the tail of one ("347 $" must not match "1347 $"). Only digits, "." and
 * "," are refused on either side: a LETTER may precede it, because Playwright's text matching joins sibling
 * elements with no separator ("No receiptCA$293", "Oct 9, 2026 · No category" + amount). Which currency a figure
 * is in is asserted separately (the [data-money] attribute), not by this pattern.
 */
export function moneyRegex(dollars: number, currency: string, locale = 'en-US'): RegExp {
  return new RegExp(`(?<![\\d.,])${escapeRegExp(money(dollars * 100, currency, locale))}(?![\\d.,])`);
}

/** What an amount <input> holds for `dollars` in `locale` (decimal separator, two places, no grouping). */
export function amountInputText(dollars: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(dollars);
}

// ── Ledger arithmetic (pure) ─────────────────────────────────────────────────

export interface PnlLine {
  accountId: string;
  code: string;
  name: string;
  amountCents: number;
}
export interface PnlSnapshot {
  grossRevenueCents: number;
  totalExpensesCents: number;
  netIncomeCents: number;
  /** accountId -> expense cents (debits - credits), accounts with no movement absent. */
  expenseByAccount: Record<string, number>;
  /** accountId -> account code ('6999' is the uncategorized suspense account). */
  codeByAccount: Record<string, string>;
}

/** The P&L route's `data` (accrual basis) as a snapshot. Tolerates a missing/garbled line list rather than throwing. */
export function parsePnl(data: {
  grossRevenueCents?: unknown;
  totalExpensesCents?: unknown;
  netIncomeCents?: unknown;
  expenses?: unknown;
} | null | undefined): PnlSnapshot {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const expenseByAccount: Record<string, number> = {};
  const codeByAccount: Record<string, string> = {};
  for (const l of Array.isArray(data?.expenses) ? (data!.expenses as Partial<PnlLine>[]) : []) {
    if (typeof l?.accountId !== 'string') continue;
    expenseByAccount[l.accountId] = (expenseByAccount[l.accountId] ?? 0) + num(l.amountCents);
    if (typeof l.code === 'string') codeByAccount[l.accountId] = l.code;
  }
  return {
    grossRevenueCents: num(data?.grossRevenueCents),
    totalExpensesCents: num(data?.totalExpensesCents),
    netIncomeCents: num(data?.netIncomeCents),
    expenseByAccount,
    codeByAccount,
  };
}

/** One account's expense in a snapshot (0 when it had no movement). */
export function expenseCentsFor(snap: PnlSnapshot, accountId: string): number {
  return snap.expenseByAccount[accountId] ?? 0;
}

/** The suspense ("Uncategorized Expenses", code 6999) account's id in a snapshot, if any line has it. */
export function suspenseAccountId(snap: PnlSnapshot): string | null {
  return Object.entries(snap.codeByAccount).find(([, code]) => code === '6999')?.[0] ?? null;
}

/** after - before for one account. */
export function accountDelta(before: PnlSnapshot, after: PnlSnapshot, accountId: string): number {
  return expenseCentsFor(after, accountId) - expenseCentsFor(before, accountId);
}

/** Every account whose expense moved between two snapshots: accountId -> after - before (zeros omitted). */
export function movedAccounts(before: PnlSnapshot, after: PnlSnapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(before.expenseByAccount), ...Object.keys(after.expenseByAccount)])) {
    const d = accountDelta(before, after, id);
    if (d !== 0) out[id] = d;
  }
  return out;
}

/** The fields of two totals snapshots that differ, as `field: before -> after` (empty = identical). */
export function diffTotals<T extends object>(before: T, after: T): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before as Record<string, unknown>)[k];
    const a = (after as Record<string, unknown>)[k];
    if (b !== a) out.push(`${k}: ${String(b)} -> ${String(a)}`);
  }
  return out;
}

/** The P&L window used by every ledger assertion: two days back to tomorrow, so a fixture dated today and
 *  its reversing entry (dated the day it was posted) are both inside it. */
export function pnlWindow(now: Date = new Date()): { startDate: string; endDate: string } {
  const today = todayIso(now);
  return { startDate: addDaysIso(today, -2), endDate: addDaysIso(today, 1) };
}

// ── Records (deployment) ─────────────────────────────────────────────────────

/** An in-page JPEG (a labelled white canvas); the label makes each fixture's file distinct. */
export async function makeReceiptJpeg(page: Page, label: string): Promise<Buffer> {
  const b64 = await page.evaluate((text) => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 800;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 600, 800);
    g.fillStyle = '#000';
    g.font = '32px sans-serif';
    g.fillText(text, 40, 120);
    g.fillText('TOTAL 12.00', 40, 700);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  }, label);
  return Buffer.from(b64, 'base64');
}

/** A confirmed business expense through the real create route (booked at once: to its category, or to 6999). */
export async function createExpense(page: Page, body: Record<string, unknown>): Promise<string> {
  const res = await api(page).post(`${EXPENSE}/expenses`, body);
  expectOk(res, 'create fixture expense');
  return res.data.data.id as string;
}

/**
 * A receipt-backed expense through the real capture route (a real Blob upload). With the amount typed and no
 * category it is born `pending_review`, uncategorized and NOT booked: the review queue's shape.
 */
export async function createReceiptExpense(
  page: Page,
  f: { vendor: string; amountCents: number; date: string; label: string },
): Promise<{ id: string; receiptUrl: string | null }> {
  const jpeg = (await makeReceiptJpeg(page, f.label)).toString('base64');
  const res = await page.evaluate(async (fx) => {
    const bytes = Uint8Array.from(atob(fx.jpeg), (ch) => ch.charCodeAt(0));
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'fixture.jpg');
    form.append('idempotencyKey', crypto.randomUUID());
    form.append('amountCents', String(fx.amountCents));
    form.append('vendor', fx.vendor);
    form.append('date', fx.date);
    const r = await fetch('/api/v1/agentbook-expense/expenses/from-receipt', { method: 'POST', body: form, credentials: 'include' });
    let data: unknown = null;
    try {
      data = await r.json();
    } catch {
      /* non-JSON */
    }
    return { status: r.status, data: data as { data?: { doc?: { id: string; receiptUrl: string | null } } } };
  }, { ...f, jpeg });
  expectOk(res, 'create receipt fixture via from-receipt');
  return { id: res.data!.data!.doc!.id, receiptUrl: res.data!.data!.doc!.receiptUrl };
}

/** Best-effort delete (reverses its journal entry). A record already gone, or a failure, is not an error here. */
export async function deleteExpenseQuietly(page: Page, id: string): Promise<void> {
  try {
    await api(page).delete(`${EXPENSE}/expenses/${id}`);
  } catch {
    /* already gone */
  }
}

/** The raw expense row (GET /expenses/:id). */
export async function getExpense(page: Page, id: string) {
  const res = await api(page).get(`${EXPENSE}/expenses/${id}`);
  return res;
}

export async function countByQuery(page: Page, q: string, extra = ''): Promise<number> {
  const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(q)}&limit=100${extra}`);
  expectOk(res, `list expenses q=${q}`);
  return (res.data.data as unknown[]).length;
}

export interface ExpenseAccount {
  id: string;
  name: string;
  code: string;
}

/** The tenant's active expense categories as the picker offers them (no 6999 suspense), stable order. */
export async function listCategoryAccounts(page: Page): Promise<ExpenseAccount[]> {
  const res = await api(page).get(`${CORE}/accounts?type=expense`);
  expectOk(res, 'list expense accounts');
  return (res.data.data as Array<Partial<ExpenseAccount>>)
    .filter((a): a is ExpenseAccount => typeof a.id === 'string' && typeof a.name === 'string' && typeof a.code === 'string' && a.code !== '6999')
    .sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
}

/** The P&L (accrual basis, the journal) over the fixed window; the same figures the reports page shows. */
export async function pnlSnapshot(page: Page): Promise<PnlSnapshot> {
  const { startDate, endDate } = pnlWindow();
  const res = await api(page).get(`${TAX}/reports/pnl?basis=accrual&startDate=${startDate}&endDate=${endDate}`);
  expectOk(res, 'P&L report');
  return parsePnl(res.data.data);
}

/** The Docs chips' counts straight from the list route (what the screen's badges are computed from). */
export async function docCounts(page: Page): Promise<DocCounts> {
  const res = await api(page).get(`${EXPENSE}/expenses?withCounts=1&limit=1`);
  expectOk(res, 'list expenses withCounts');
  return res.data.meta.counts as DocCounts;
}

/** The query string the screen sends for a chip, built from the shared table. */
export function filterQuery(filter: DocFilter, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ ...DOC_FILTER_PARAMS[filter], ...extra }).toString();
}

/** A chip's whole list size (meta.total) and its first rows, from the list route. */
export async function listFilter(page: Page, filter: DocFilter, extra: Record<string, string> = {}) {
  const res = await api(page).get(`${EXPENSE}/expenses?${filterQuery(filter, { limit: '100', ...extra })}`);
  expectOk(res, `list expenses filter=${filter}`);
  return { total: res.data.meta.total as number, rows: res.data.data as Array<{ id: string }> };
}

export interface Totals {
  revenueCents: number;
  expensesCents: number;
  taxCents: number;
  owedCents: number;
  monthNetCents: number | null;
  cashCents: number | null;
  outstandingCents: number;
  estTaxCents: number | null;
  pnlExpensesCents: number;
  pnlRevenueCents: number;
}

/**
 * Every headline figure a user could see change, from the three independent sources: the tax estimate (the
 * books), the Home KPIs (what the phone shows) and the P&L (the journal). Archiving must not move ANY of them;
 * a fixture's whole lifecycle must leave them where they started.
 */
export async function totalsSnapshot(page: Page): Promise<Totals> {
  const est = await api(page).get(`${TAX}/tax/estimate`);
  expectOk(est, 'tax estimate');
  const home = await api(page).get(`${CORE}/mobile/home`);
  expectOk(home, 'mobile home');
  const pnl = await pnlSnapshot(page);
  const e = est.data.data;
  const k = home.data.data.kpis;
  return {
    revenueCents: e.grossRevenueCents,
    expensesCents: e.expensesCents,
    taxCents: e.totalTaxCents,
    owedCents: e.amountOwedCents,
    monthNetCents: k.monthNetCents,
    cashCents: k.cashTodayCents,
    outstandingCents: k.outstandingCents,
    estTaxCents: k.estTaxOwedCents,
    pnlExpensesCents: pnl.totalExpensesCents,
    pnlRevenueCents: pnl.grossRevenueCents,
  };
}


// ── Error collector (PR 7 / spec §8.3) ───────────────────────────────────────

/**
 * Spec §8.3: "no unhandled promise rejections or console errors during the
 * journeys". Auto fixture: every test using THIS `test` fails on any of them.
 * unhandledrejection is re-emitted as console.error by an init script because
 * not every engine reports it as a pageerror. Specs that import `test` from
 * '@playwright/test' are unaffected.
 */
export interface Collected { console: string[]; pageErrors: string[] }
/**
 * Console lines that are known, benign and fully explained. Every entry is an exact-prefix match and says why.
 * - The shell's auth + plugin hydrators log `console.error('Error fetching user|plugins: ...', err)` when a request they
 *   have IN FLIGHT is aborted by a navigation (a journey that clicks a link mid-load, or a deliberate reload). The abort
 *   surfaces as `TypeError: Failed to fetch`. It is OUR app's log, but it is the navigation, not a failure: a genuinely
 *   failing API also fails the assertions on the data. Anything else the app logs still fails the test.
 */
const IGNORED_CONSOLE: RegExp[] = [
  /^Error fetching user: TypeError: Failed to fetch/,
  /^Error fetching plugins: Failed to fetch/,
];

export const test = base.extend<{ errors: Collected; strictErrors: boolean }>({
  strictErrors: [true, { option: true }],
  errors: [
    async ({ page, strictErrors }, use, testInfo) => {
      const c: Collected = { console: [], pageErrors: [] };
      await page.addInitScript(() => {
        window.addEventListener('unhandledrejection', (e) => {
          const r = (e as PromiseRejectionEvent).reason;
          console.error(`unhandledrejection: ${r && r.message ? r.message : String(r)}`);
        });
      });
      page.on('console', (msg) => { if (msg.type() === 'error') c.console.push(msg.text()); });
      page.on('pageerror', (err) => c.pageErrors.push(String(err?.stack ?? err)));
      await use(c);
      const consoleErrors = c.console
        .filter((m) => !IGNORED_CONSOLE.some((re) => re.test(m)))
        .filter((m) => strictErrors || !/Failed to load resource/i.test(m));
      expect(c.pageErrors, `uncaught errors in "${testInfo.title}"`).toEqual([]);
      expect(consoleErrors, `console errors in "${testInfo.title}"`).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
