import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { DocFilter, MobileHome } from '../../../apps/web-next/src/lib/mobile/types';
import { alertCopy } from '../../../apps/web-next/src/app/app/_lib/alert-copy';
import { BADGES_ENABLED } from '../../../apps/web-next/src/app/app/_shell/badges';
import {
  MOBILE_VIEWPORT,
  HOME_SNAPSHOT_STORAGE_KEY,
  catalogT,
  docsBadgeText,
  expectedDocsBadge,
  isHomeGet,
  loginAs,
  loginUnavailableReason,
  newPersonaContext,
  openHome,
  pageLocales,
  settle,
  showAlert,
  tabNav,
  waitForHomeSnapshot,
  type CatalogT,
} from './helpers';
import {
  PERSONA_CURRENCY,
  accountDelta,
  amountInputText,
  createExpense,
  createReceiptExpense,
  deleteExpenseQuietly,
  diffTotals,
  docCounts,
  escapeRegExp,
  expenseCentsFor,
  getExpense,
  listCategoryAccounts,
  listFilter,
  moneyRegex,
  movedAccounts,
  placeholderRegex,
  pnlSnapshot,
  randomWholeDollars,
  runTag,
  suspenseAccountId,
  todayIso,
  totalsSnapshot,
  type ExpenseAccount,
  type Persona,
  type PnlSnapshot,
  type Totals,
} from './fixtures';
import { api } from '../nightly/helpers/api';

/**
 * Docs journeys (spec 8.1(7)(b)) per persona, against a DEPLOYED site.
 *
 * Rules this file keeps:
 *  - Every assertion is on RENDERED content (names, amounts, counts) AND on the server's state (the API read
 *    back after the UI acted); a URL or a visibility check alone is never the proof.
 *  - All text comes from the app's own catalog (catalogT) and money from the app's own formatter, in the
 *    page's locale: nothing here hardcodes English.
 *  - A FRESH browser context per persona (newPersonaContext): one page re-logged-in across personas keeps the
 *    first one's localStorage token and reads the first one's books (the PR 3 production defect).
 *  - Every record is created here, tagged (runTag) and deleted in afterAll even when a test fails; the final
 *    test asserts the persona's totals ended where they started.
 *  - Serial per persona: the journeys compare the P&L before/after one UI action, which a concurrent writer
 *    would perturb.
 *
 * The ledger is read from the P&L report (GET agentbook-tax/reports/pnl, accrual: the JOURNAL), not from the
 * expense table, so "the amount moved to the new category" is proved in the books, not just on the row.
 */

const PERSONAS: Persona[] = ['maya', 'alex', 'sydney'];
const PAGE_SIZE = 30; // docs/page.tsx PAGE_SIZE: the first page of a list
const MAX_ALERTS = 5; // lib/mobile/alerts.ts MAX_ALERTS (a server module Playwright cannot import)
const REVIEW_PATH = '**/api/v1/agentbook-core/auto-categorize/review';
const PENDING_PATH = '**/api/v1/agentbook-core/auto-categorize/pending';
const FILTERS: DocFilter[] = ['needs-review', 'no-category', 'no-receipt', 'all', 'archived'];
const COUNTED: Array<Exclude<DocFilter, 'all'>> = ['needs-review', 'no-category', 'no-receipt', 'archived'];
const COUNT_KEY = { 'needs-review': 'needsReview', 'no-category': 'noCategory', 'no-receipt': 'noReceipt', archived: 'archived' } as const;
const LABEL_KEY: Record<DocFilter, string> = {
  'needs-review': 'mobile.docs.filter_needs_review',
  'no-category': 'mobile.docs.filter_no_category',
  'no-receipt': 'mobile.docs.filter_no_receipt',
  all: 'mobile.docs.filter_all',
  archived: 'mobile.docs.filter_archived',
};
const EMPTY_TITLE_KEY: Record<DocFilter, string> = {
  'needs-review': 'mobile.docs.empty_needs_review_title',
  'no-category': 'mobile.docs.empty_no_category_title',
  'no-receipt': 'mobile.docs.empty_no_receipt_title',
  all: 'mobile.docs.empty_all_title',
  archived: 'mobile.docs.empty_archived_title',
};
/** Home alert kind -> the Docs chip its link must land on (lib/mobile/home.ts). */
const ALERT_CHIPS = [
  ['review_needed', 'needs-review'],
  ['receipts_missing', 'no-receipt'],
  ['uncategorized', 'no-category'],
] as const;

interface Doc {
  id: string;
  vendor: string;
  dollars: number;
}

for (const persona of PERSONAS) {
  test.describe(`@mobile-docs ${persona}`, () => {
    test.describe.configure({ mode: 'serial' });

    const currency = PERSONA_CURRENCY[persona];
    const tag = runTag(`E2EDOC${persona.slice(0, 2)}`);
    let context: BrowserContext;
    let page: Page;
    let t: CatalogT;
    let locale = 'en-US';
    let baseline: Totals;
    let cats: { x: ExpenseAccount; y: ExpenseAccount; p: ExpenseAccount };
    // A: confirmed, no receipt, NO category (booked to the 6999 suspense account). B: receipt, pending review,
    // NO category, not booked. C: confirmed, category X, no receipt, booked. D: like C but $5 (under the Home
    // "missing receipt" threshold). All dated today, all tagged.
    let A: Doc;
    let B: Doc;
    let C: Doc;
    let D: Doc;
    const created: string[] = [];

    const money = (dollars: number) => moneyRegex(dollars, currency, locale);
    const picker = () => page.getByRole('dialog', { name: t('mobile.docs.choose_category') });
    const filtersGroup = () => page.getByRole('group', { name: t('mobile.docs.filters_label') });
    const chip = (f: DocFilter) => filtersGroup().getByRole('button', { name: new RegExp(`^${escapeRegExp(t(LABEL_KEY[f]))}\\s*\\d*$`) });
    const chipCount = (f: DocFilter) => chip(f).locator('span').last();
    const rows = () => page.getByTestId('doc-item');
    const rowOf = (d: Doc) => rows().filter({ hasText: d.vendor });
    const results = () => page.getByTestId('docs-results');
    const toast = () => page.getByRole('status', { name: t('mobile.kit.notifications') });
    const alerts = () => page.getByRole('alert', { name: t('mobile.kit.alerts') });
    const read = async (d: Doc) => (await getExpense(page, d.id)).data.data as {
      categoryId: string | null;
      amountCents: number;
      status: string;
      isPersonal: boolean;
      archivedAt: string | null;
      journalEntryId: string | null;
      vendorName: string | null;
      receiptUrl: string | null;
    };
    const centsOf = (d: Doc) => d.dollars * 100;
    // A banner's title is "<visually-hidden severity word> <title>": match the title at the END of the text.
    const bannerTitle = (title: string) => page.getByText(new RegExp(`${escapeRegExp(title)}$`));

    async function openList(query = ''): Promise<void> {
      await page.goto(`/app/docs${query}`);
      await expect(page.getByRole('heading', { name: t('common.documents') })).toBeVisible();
    }

    /** Open a document. An UNCATEGORIZED one opens the category picker by itself; that is asserted, then (by default) dismissed. */
    async function openDoc(d: Doc, opts: { uncategorized: boolean; keepPicker?: boolean }): Promise<void> {
      await page.goto(`/app/docs/${d.id}`);
      await settleViewer(opts);
    }
    async function settleViewer(opts: { uncategorized: boolean; keepPicker?: boolean }): Promise<void> {
      await expect(page.getByTestId('doc-amount')).toBeVisible();
      if (!opts.uncategorized) return;
      await expect(picker(), 'an uncategorized document opens the category picker by itself').toBeVisible({ timeout: 15_000 });
      if (!opts.keepPicker) {
        await page.keyboard.press('Escape');
        await expect(picker()).toBeHidden();
      }
    }

    /** P&L before -> after: exactly these accounts moved by exactly these cents, the total by `totalDelta`, revenue not at all. */
    async function expectLedger(before: PnlSnapshot, moved: Record<string, number>, totalDelta: number, label: string): Promise<PnlSnapshot> {
      const after = await pnlSnapshot(page);
      expect(movedAccounts(before, after), `${label}: the accounts whose expense moved (cents)`).toEqual(moved);
      expect(after.totalExpensesCents - before.totalExpensesCents, `${label}: total expenses moved by`).toBe(totalDelta);
      expect(after.grossRevenueCents, `${label}: revenue must not move`).toBe(before.grossRevenueCents);
      return after;
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const baseURL = testInfo.project.use.baseURL;
      const reason = loginUnavailableReason(baseURL);
      test.skip(reason !== null, reason ?? '');
      context = await newPersonaContext(browser, baseURL);
      page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app/docs');
      await settle(page);
      const loc = await pageLocales(page);
      t = catalogT(loc.stringLocale);
      locale = loc.formatLocale;

      baseline = await totalsSnapshot(page);
      const accounts = await listCategoryAccounts(page);
      expect(accounts.length, `${persona} needs three expense categories to move amounts between`).toBeGreaterThanOrEqual(3);
      cats = { x: accounts[0], y: accounts[1], p: accounts[2] };

      const today = todayIso();
      const mk = (name: string): Doc => ({ id: '', vendor: `${tag} ${name}`, dollars: randomWholeDollars() });
      A = mk('Alpha');
      B = mk('Beta');
      C = mk('Gamma');
      D = { id: '', vendor: `${tag} Delta`, dollars: 5 };
      const body = (d: Doc, extra: Record<string, unknown> = {}) => ({
        amountCents: d.dollars * 100, vendor: d.vendor, description: d.vendor.toLowerCase(), date: today, currency, isPersonal: false, ...extra,
      });
      A.id = await createExpense(page, body(A));
      created.push(A.id);
      ({ id: B.id } = await createReceiptExpense(page, { vendor: B.vendor, amountCents: B.dollars * 100, date: today, label: B.vendor }));
      created.push(B.id);
      C.id = await createExpense(page, body(C, { categoryId: cats.x.id }));
      created.push(C.id);
      D.id = await createExpense(page, body(D, { categoryId: cats.x.id }));
      created.push(D.id);

      // The shapes every journey below starts from, asserted rather than assumed.
      const [a, b, c] = await Promise.all([read(A), read(B), read(C)]);
      expect(a, 'A: confirmed, uncategorized, booked (to the suspense account), no receipt').toMatchObject({ categoryId: null, status: 'confirmed', receiptUrl: null });
      expect(a.journalEntryId, 'A is booked').not.toBeNull();
      expect(b, 'B: pending review, uncategorized, with a receipt').toMatchObject({ categoryId: null, status: 'pending_review' });
      expect(b.receiptUrl, 'B has a receipt').toBeTruthy();
      expect(b.journalEntryId, 'B is not booked until it has a category').toBeNull();
      expect(c, 'C: confirmed, categorized').toMatchObject({ categoryId: cats.x.id, status: 'confirmed' });
    });

    test.afterEach(async ({}, testInfo) => {
      // A screenshot of the phone at the moment of failure (the page has a masked password field at most; no trace/video is ever on).
      if (page && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('failure', { body: await page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
      }
    });

    test.afterAll(async () => {
      if (!page) return;
      try {
        for (const id of created) await deleteExpenseQuietly(page, id);
      } finally {
        await context.close();
      }
    });

    // ── list ────────────────────────────────────────────────────────────────

    test('list: every chip shows the API count and lands pressed, with its own list and result count', async () => {
      test.setTimeout(150_000);
      const counts = await docCounts(page);
      await openList();
      for (const f of COUNTED) await expect(chipCount(f), `${f} chip count`).toHaveText(String(counts[COUNT_KEY[f]]));
      // "All" carries no number: the total is not something anyone needs to clear.
      await expect(chip('all').locator('span')).toHaveCount(1);

      for (const f of FILTERS) {
        await chip(f).click();
        await expect(chip(f)).toHaveAttribute('aria-pressed', 'true');
        for (const other of FILTERS.filter((o) => o !== f)) await expect(chip(other)).toHaveAttribute('aria-pressed', 'false');
        if (f === 'all') await expect(page).toHaveURL((u) => u.pathname === '/app/docs' && !u.searchParams.has('filter'));
        else await expect(page).toHaveURL((u) => u.pathname === '/app/docs' && u.searchParams.get('filter') === f);

        // The list the chip shows is the list the API returns for the SAME params (the shared DOC_FILTER_PARAMS table).
        const { total } = await listFilter(page, f);
        await expect(results(), `${f}: result count`).toHaveText(total === 0 ? t('mobile.docs.results_none') : t('mobile.docs.results', { count: total }));
        if (total === 0) {
          await expect(page.getByRole('heading', { name: t(EMPTY_TITLE_KEY[f]), exact: true }), `${f}: the empty state`).toBeVisible();
        } else {
          const n = await rows().count();
          expect(n, `${f}: rows on the first page`).toBeGreaterThanOrEqual(Math.min(total, PAGE_SIZE));
          expect(n, `${f}: rows never exceed the list`).toBeLessThanOrEqual(total);
        }
        // A chip's badge IS its list's size (same where-clause server-side), for every counted chip.
        if (f !== 'all') expect(total, `${f}: chip count vs list total`).toBe(counts[COUNT_KEY[f]]);
      }
    });

    test('search + chips on this run\'s records: each chip lists exactly the fixtures it should, with amounts and category text', async () => {
      await openList(`?q=${encodeURIComponent(tag)}`);
      // All: the four fixtures, each with its money in the tenant currency and its category / receipt state.
      for (const d of [A, B, C, D]) await expect(rowOf(d), `${d.vendor} is listed`).toHaveCount(1);
      await expect(rowOf(A)).toContainText(money(A.dollars));
      await expect(rowOf(B)).toContainText(money(B.dollars));
      await expect(rowOf(C)).toContainText(money(C.dollars));
      await expect(rowOf(D)).toContainText(money(D.dollars));
      await expect(rowOf(A)).toContainText(t('mobile.docs.no_category'));
      await expect(rowOf(C)).toContainText(cats.x.name);
      await expect(rowOf(A)).toContainText(t('mobile.docs.row_no_receipt'));
      await expect(rowOf(B)).not.toContainText(t('mobile.docs.row_no_receipt'));
      await expect(rowOf(B)).toContainText(t('mobile.docs.review_pill'));
      await expect(rows()).toHaveCount(4);

      const only = async (f: DocFilter, expected: Doc[]) => {
        await chip(f).click();
        await expect(page).toHaveURL((u) => u.searchParams.get('filter') === f && u.searchParams.get('q') === tag);
        await expect(rows(), `${f} + search`).toHaveCount(expected.length);
        for (const d of expected) await expect(rowOf(d)).toHaveCount(1);
      };
      await only('no-receipt', [A, C, D]); // B has a receipt
      await only('needs-review', [B]); // only B is pending review
      await only('no-category', [A, B]); // C and D carry category X
      await chip('archived').click();
      await expect(rows(), 'nothing of this run is archived yet').toHaveCount(0);
      await expect(page.getByRole('heading', { name: t('mobile.docs.empty_search_title'), exact: true })).toBeVisible();
      await chip('all').click();
      await expect(rows()).toHaveCount(4);
    });

    // ── Home alerts and the tab badge ───────────────────────────────────────

    test('Home alert deep links land on /app/docs with the right chip pressed and its list', async () => {
      test.setTimeout(180_000);
      for (const [kind, filter] of ALERT_CHIPS) {
        const { t: tt, home, fmt } = await openHome(page);
        const shown = home.alerts.slice(0, MAX_ALERTS);
        const index = shown.findIndex((a) => a.kind === kind);
        if (index === -1) {
          // The fixtures guarantee the count behind each of these alerts (A and D have no receipt, A and B no category,
          // B is pending review), so the ONLY legitimate reason for an absent alert is the server's 5-alert cap.
          expect(home.alerts.length, `${kind}: the alert is missing although its count is >0; only a full list (the cap) may hide it`).toBe(MAX_ALERTS);
          test.info().annotations.push({ type: `alert-${kind}`, description: `crowded out by ${MAX_ALERTS} higher-ranked alerts: the link's target was opened directly` });
          await page.goto(`/app/docs?filter=${filter}`);
        } else {
          const alert = shown[index];
          expect(alert.target?.route, `${kind} target`).toBe('/app/docs');
          expect(alert.target?.query?.filter, `${kind} target filter`).toBe(filter);
          const carousel = await showAlert(page, tt, shown.length, index);
          const copy = alertCopy(alert, tt, fmt);
          await expect(carousel).toContainText(copy.title);
          await carousel.getByRole('link', { name: copy.actionLabel!, exact: true }).click();
          test.info().annotations.push({ type: `alert-${kind}`, description: 'the real banner link was followed' });
        }
        await expect(page).toHaveURL((u) => u.pathname === '/app/docs' && u.searchParams.get('filter') === filter);
        await expect(page.getByRole('heading', { name: t('common.documents') })).toBeVisible();
        await expect(chip(filter), `${kind} -> ${filter} chip`).toHaveAttribute('aria-pressed', 'true');
        const { total } = await listFilter(page, filter);
        await expect(results()).toHaveText(total === 0 ? t('mobile.docs.results_none') : t('mobile.docs.results', { count: total }));
        // This run's fixtures are in the list the alert opened.
        if (total > 0 && total <= PAGE_SIZE) {
          const expected = filter === 'needs-review' ? [B] : filter === 'no-receipt' ? [A, C, D] : [A, B];
          for (const d of expected) await expect(rowOf(d), `${d.vendor} in ${filter}`).toHaveCount(1);
        }
      }
    });

    test('Docs tab badge: the needs-review count Home reports, and it equals the Needs review chip', async () => {
      test.setTimeout(120_000);
      expect(BADGES_ENABLED.docs, 'the Docs badge is live (flipped in PR 4)').toBe(true);
      // The shell revalidates a missing/old snapshot: drop this context's so the shell makes its own request,
      // awaited BEFORE navigating so it cannot be missed.
      await page.evaluate((key) => window.localStorage.removeItem(key), HOME_SNAPSHOT_STORAGE_KEY);
      const homeResponse = page.waitForResponse(isHomeGet, { timeout: 30_000 });
      await page.goto('/app/docs');
      const home = ((await (await homeResponse).json()) as { data: MobileHome }).data;
      await waitForHomeSnapshot(page, home.generatedAt);
      await settle(page);
      const nav = tabNav(page, t);
      const docsTab = nav.locator('a[data-tab="/app/docs"]');
      const badge = docsTab.locator('[data-badge="docs-count"]');

      const reviewAlert = home.alerts.find((a) => a.kind === 'review_needed');
      const expected = expectedDocsBadge(home, BADGES_ENABLED.docs);
      if (!reviewAlert) {
        // B is pending review, so needs-review > 0: the alert may only be missing because the cap hid it.
        expect(home.alerts.length, 'review_needed missing although a document is pending review: only the cap may hide it').toBe(MAX_ALERTS);
        await expect(badge).toHaveCount(0);
        test.info().annotations.push({ type: 'docs-badge', description: 'the review_needed alert was crowded out by the 5-alert cap: badge absent while the chip is > 0 (documented disagreement)' });
        return;
      }
      expect(expected, 'B is pending review, so the badge is positive').toBeGreaterThan(0);
      await expect(badge).toHaveText(docsBadgeText(expected));
      await expect(docsTab).toHaveAttribute('aria-label', t('mobile.tabs.docs_review', { count: expected }));
      // The badge predicate IS the Needs review chip's: both are the pending_review list's size.
      const counts = await docCounts(page);
      expect(expected, 'badge vs Needs review chip count (API)').toBe(counts.needsReview);
      await expect(chipCount('needs-review')).toHaveText(String(counts.needsReview));
    });

    // KNOWN DISAGREEMENT (Task 4.7b alignment pending): the Home "receipts missing" alert and the "No receipt" chip
    // do not count the same rows. Written against TODAY's behaviour; the aligned expectation is the test.fixme below.
    //   alert (lib/mobile/alerts.ts missingReceiptWhere): business, status = confirmed, amount > $25, dated in the last 90 days, no receipt.
    //   chip  (DOC_FILTER_PARAMS['no-receipt']):          business, ANY status, ANY amount, ANY date, no receipt.
    test('KNOWN DISAGREEMENT (Task 4.7b): the receipts alert counts a narrower set than the No receipt chip; D ($5) is only in the chip', async () => {
      test.setTimeout(120_000);
      const { home } = await openHome(page);
      const alert = home.alerts.slice(0, MAX_ALERTS).find((a) => a.kind === 'receipts_missing');
      test.skip(!alert, 'the receipts_missing alert was crowded out by the 5-alert cap; the comparison needs it');
      const alertCount = Number(alert!.params.count);
      const counts = await docCounts(page);
      expect(alertCount, 'alert count (confirmed, > $25, last 90 days, no receipt)').toBeGreaterThan(0); // A qualifies
      expect(alertCount, 'D is $5: in the chip, not in the alert').toBeLessThan(counts.noReceipt);
      // When the whole chip list fits one request, the alert's number is exactly the alert predicate applied to the chip's rows.
      const list = await api(page).get(`/api/v1/agentbook-expense/expenses?hasReceipt=false&isPersonal=false&limit=100`);
      const all = list.data.data as Array<{ status: string; amountCents: number; date: string }>;
      if (list.data.meta.total <= 100) {
        const cutoff = Date.now() - 90 * 86_400_000; // missingReceiptWhere: date >= now - 90 days (an instant, not a calendar day)
        const narrow = all.filter((r) => r.status === 'confirmed' && r.amountCents > 2500 && Date.parse(r.date) >= cutoff).length;
        expect(alertCount, 'alert count = the alert predicate over the chip rows').toBe(narrow);
      }
    });

    test.fixme('Task 4.7b alignment: the receipts alert count equals the No receipt chip count (same DOC_FILTER_PARAMS table)', async () => {
      const { home } = await openHome(page);
      const alert = home.alerts.find((a) => a.kind === 'receipts_missing');
      const counts = await docCounts(page);
      expect(Number(alert?.params.count), 'alert and chip must count the same rows').toBe(counts.noReceipt);
    });

    test.fixme('Task 4.7b alignment: a review_needed alert whose count is 0 (only AI suggestions waiting) does not land on an empty "Nothing needs review" list', async () => {
      // Today: review_needed fires for needsReview > 0 OR suggestions > 0; with only suggestions its deep link opens the
      // Needs review chip, which lists pending_review rows only, so the user lands on "Nothing needs review".
      // Needs a persona with suggestions and nothing pending review; the aligned behaviour is either a link to the AI
      // picks sheet or a chip list that includes suggestion rows. Pin whichever the server task chooses.
      const { home } = await openHome(page);
      const alert = home.alerts.find((a) => a.kind === 'review_needed' && Number(a.params.count) === 0 && Number(a.params.suggestions) > 0);
      expect(alert, 'a persona with AI suggestions waiting and nothing pending review').toBeTruthy();
      await page.goto(`/app/docs?filter=${alert!.target!.query!.filter}`);
      await expect(page.getByRole('heading', { name: t('mobile.docs.empty_needs_review_title'), exact: true })).toHaveCount(0);
    });

    // ── viewer ───────────────────────────────────────────────────────────────

    test('open a document from its row: vendor, amount, date, category and receipt state render, with the form holding the saved values', async () => {
      await openList(`?q=${encodeURIComponent(tag)}`);
      await rowOf(A).click();
      await expect(page).toHaveURL(new RegExp(`/app/docs/${A.id}$`));
      await settleViewer({ uncategorized: true }); // A is uncategorized: the picker opens itself (asserted), then closes
      await expect(page.getByRole('heading', { level: 1, name: A.vendor })).toBeVisible();
      await expect(page.getByTestId('doc-amount')).toContainText(money(A.dollars));
      await expect(page.getByTestId('doc-category')).toContainText(t('mobile.docs.no_category'));
      await expect(page.getByTestId('no-receipt-tile')).toContainText(t('mobile.docs.no_receipt_tile'));
      await expect(page.getByLabel(t('mobile.docs.field_vendor'), { exact: true })).toHaveValue(A.vendor);
      await expect(page.getByLabel(t('mobile.docs.field_amount'), { exact: true })).toHaveValue(amountInputText(A.dollars, locale));
      await expect(page.getByLabel(t('mobile.docs.field_date'), { exact: true })).toHaveValue(todayIso());
      // Nothing is dirty yet: Save is inert, and a confirmed document offers no "Mark as reviewed".
      await expect(page.getByTestId('save-changes')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('button', { name: t('mobile.docs.mark_reviewed'), exact: true })).toHaveCount(0);

      // B: a receipt image, the review pill, and "Mark as reviewed" held back until there is a category.
      await openDoc(B, { uncategorized: true });
      await expect(page.getByRole('heading', { level: 1, name: B.vendor })).toBeVisible();
      await expect(page.getByTestId('doc-amount')).toContainText(money(B.dollars));
      await expect(page.getByText(t('mobile.docs.needs_review_banner'), { exact: true })).toBeVisible();
      // The viewer is a role="img" box (named "Receipt image") around the real <img>.
      await expect(page.getByRole('img', { name: t('mobile.docs.receipt_alt') })).toBeVisible();
      const receipt = page.getByTestId('pinch-zoom-img');
      await expect(receipt).toBeVisible();
      await expect.poll(() => receipt.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: 'the receipt image decoded' }).toBe(true);
      await expect(page.getByRole('button', { name: t('mobile.docs.mark_reviewed'), exact: true })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText(t('mobile.docs.review_needs_category'), { exact: true })).toBeVisible();
    });

    test('previous / next walk this run\'s list in the order it showed, and stop at both ends', async () => {
      await openList(`?q=${encodeURIComponent(tag)}`);
      await expect(rows()).toHaveCount(4);
      const ids = (await rows().evaluateAll((els) => els.map((e) => (e.getAttribute('href') ?? '').split('/').pop() ?? ''))) as string[];
      expect([...ids].sort()).toEqual([A.id, B.id, C.id, D.id].sort());
      const uncategorized = new Set([A.id, B.id]);
      const prev = () => page.getByRole('link', { name: t('mobile.docs.prev'), exact: true });
      const next = () => page.getByRole('link', { name: t('mobile.docs.next'), exact: true });

      await rows().first().click();
      await expect(page).toHaveURL(new RegExp(`/app/docs/${ids[0]}$`));
      await settleViewer({ uncategorized: uncategorized.has(ids[0]) });
      await expect(prev(), 'first document: no previous').toHaveCount(0);
      for (let i = 1; i < ids.length; i++) {
        await expect(next()).toHaveCount(1);
        await next().click();
        await expect(page).toHaveURL(new RegExp(`/app/docs/${ids[i]}$`));
        await settleViewer({ uncategorized: uncategorized.has(ids[i]) });
        await expect(prev(), `document ${i + 1}: previous exists`).toHaveCount(1);
      }
      await expect(next(), 'last document: no next').toHaveCount(0);
      // Back goes to the list it came from, with its search.
      await expect(page.getByRole('link', { name: t('mobile.docs.back') })).toHaveAttribute('href', `/app/docs?q=${encodeURIComponent(tag)}`);
      await prev().click();
      await expect(page).toHaveURL(new RegExp(`/app/docs/${ids[ids.length - 2]}$`));
    });

    // ── AI picks (deterministic: no Gemini) ─────────────────────────────────
    // The AI's pending picks live in ONE per-tenant memory row that only the (Gemini-backed) auto-categorize run
    // writes, and overwriting a persona's real batch would be destructive. So the READ (GET .../pending) is
    // injected with picks for this run's own uncategorized fixtures; every WRITE the UI makes goes to the real
    // review route, except one accept that is answered in-browser (the server holds no stored pick to apply).

    const pick = (d: Doc, category: ExpenseAccount, confidence = 0.74) => ({
      expenseId: d.id, vendorName: d.vendor, amountCents: d.dollars * 100, date: todayIso(), description: null,
      suggestedCategoryId: category.id, suggestedCategoryName: category.name, confidence, reason: 'e2e',
    });
    const injectPending = (items: unknown[]) =>
      page.route(PENDING_PATH, (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { uncategorizedCount: items.length, totalCount: items.length, uncategorizedPct: 100, items } }),
        });
      });

    test('AI picks: the banner counts the picks, the Review sheet sends BARE accept / reject, and a resolved pick leaves the sheet', async () => {
      test.setTimeout(150_000);
      await injectPending([pick(A, cats.y), pick(B, cats.p)]);
      const bodies: Array<{ items: Array<{ expenseId: string; action: string; categoryId?: string }> }> = [];
      await page.route(REVIEW_PATH, async (route) => {
        const req = route.request();
        if (req.method() !== 'POST') return route.fallback();
        const body = req.postDataJSON();
        bodies.push(body);
        // Accept is answered in the browser: the server holds no stored pick for A, so a real bare accept is
        // 'no_suggestion' (asserted in the next test). Reject goes to the real route.
        if (body.items[0].action === 'accept') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { results: [{ expenseId: body.items[0].expenseId, ok: true }] } }) });
        }
        // fallback(), not continue(): the request goes on to the network (or the next handler), unchanged.
        return route.fallback();
      });
      try {
        await openList();
        await expect(bannerTitle(t('mobile.docs.ai_pending', { m: 2 }))).toBeVisible();
        await page.getByRole('button', { name: t('mobile.docs.review_ai_picks'), exact: true }).click();
        const sheet = page.getByRole('dialog', { name: t('mobile.docs.review_title') });
        await expect(sheet).toBeVisible();
        const reviewRows = sheet.getByTestId('review-row');
        await expect(reviewRows).toHaveCount(2);
        const rowA = reviewRows.filter({ hasText: A.vendor });
        await expect(rowA).toContainText(money(A.dollars));
        await expect(rowA).toContainText(t('mobile.docs.suggested', { category: cats.y.name }));
        await expect(rowA).toContainText(t('mobile.docs.confidence', { pct: 74 }));

        await sheet.getByRole('button', { name: t('mobile.docs.accept_for', { category: cats.y.name, vendor: A.vendor }), exact: true }).click();
        await expect(sheet.getByTestId('review-status')).toHaveText(t('mobile.docs.review_resolved', { count: 1 }));
        await expect(reviewRows).toHaveCount(1);
        // A BARE accept: the server applies its own stored pick and keeps its stale-accept guard. An explicit
        // categoryId would overwrite a category the user chose elsewhere since the list loaded.
        expect(bodies[0]).toEqual({ items: [{ expenseId: A.id, action: 'accept' }] });

        const rejected = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auto-categorize/review') && r.request().method() === 'POST');
        await sheet.getByRole('button', { name: t('mobile.docs.reject_for', { category: cats.p.name, vendor: B.vendor }), exact: true }).click();
        await expect(sheet.getByText(t('mobile.docs.review_empty'), { exact: true })).toBeVisible();
        expect(bodies[1]).toEqual({ items: [{ expenseId: B.id, action: 'reject' }] });
        // The reject is a REAL write: the server answers ok for an expense of this tenant (it only drops a stored pick, here none).
        expect((await (await rejected).json()).data.results[0]).toMatchObject({ expenseId: B.id, ok: true });
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        // No picks left: the banner falls back to the live "without a category" count (the list was re-read).
        const counts = await docCounts(page);
        await expect(bannerTitle(t('mobile.docs.ai_idle', { k: counts.noCategory }))).toBeVisible();
      } finally {
        await page.unroute(REVIEW_PATH);
        await page.unroute(PENDING_PATH);
      }
      // The faked accept never reached the server, so nothing was categorized: the books are as they were.
      expect((await read(A)).categoryId, 'A untouched').toBeNull();
      expect((await read(B)).categoryId, 'B untouched').toBeNull();
    });

    test('AI pick on the viewer: the chip shows the pick; accepting a pick the server no longer holds writes nothing and says so', async () => {
      test.setTimeout(120_000);
      const before = await pnlSnapshot(page);
      await injectPending([pick(B, cats.p, 0.81)]);
      try {
        await page.goto(`/app/docs/${B.id}`);
        await expect(page.getByTestId('doc-amount')).toBeVisible();
        const chipEl = page.getByTestId('ai-suggestion');
        await expect(chipEl).toBeVisible();
        await expect(chipEl).toContainText(t('mobile.docs.suggested', { category: cats.p.name }));
        await expect(chipEl).toContainText(t('mobile.docs.confidence', { pct: 81 }));
        // The pick is shown, so the picker does not cover it.
        await expect(picker()).toBeHidden();

        const reviewed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auto-categorize/review') && r.request().method() === 'POST');
        await chipEl.getByTestId('accept-suggestion').click();
        const res = await reviewed;
        expect(res.request().postDataJSON(), 'the viewer sends a bare accept').toEqual({ items: [{ expenseId: B.id, action: 'accept' }] });
        // REAL server: no pick is stored for B, so nothing is applied (the stale-accept guard / no_suggestion).
        expect((await res.json()).data.results[0]).toMatchObject({ expenseId: B.id, ok: false, error: 'no_suggestion' });
        await expect(alerts()).toContainText(t('mobile.docs.categorize_failed'));
        await expect(page.getByTestId('ai-suggestion'), 'the pick is gone, not shown as accepted').toHaveCount(0);
        await expect(page.getByTestId('doc-category')).toContainText(t('mobile.docs.no_category'));
      } finally {
        await page.unroute(PENDING_PATH);
      }
      const b = await read(B);
      expect(b.categoryId, 'nothing was categorized').toBeNull();
      expect(b.status).toBe('pending_review');
      await expectLedger(before, {}, 0, 'a refused accept');
    });

    // ── category journeys, checked in the books ──────────────────────────────

    test('categorize an UNCATEGORIZED document: the category shows, survives reload, and its amount MOVES from the suspense account to the category', async () => {
      test.setTimeout(150_000);
      const a0 = await read(A);
      test.skip(a0.categoryId !== null, 'auto-categorize categorized fixture A before this test ran; the re-categorize journey below covers the booked-category path');
      const before = await pnlSnapshot(page);
      const suspense = suspenseAccountId(before);
      expect(suspense, 'A is booked to the 6999 uncategorized account, which must appear in the P&L').not.toBeNull();

      await openDoc(A, { uncategorized: true, keepPicker: true });
      const search = page.getByLabel(t('mobile.docs.category_search'), { exact: true });
      await search.fill(cats.p.name);
      const options = picker().getByTestId('category-option');
      await expect(picker().locator(`[data-category-id="${cats.p.id}"]`)).toBeVisible();
      // Search narrowed the list: every offered row matches what was typed (name or code).
      for (const text of await options.evaluateAll((els) => els.map((e) => (e.textContent ?? '').toLowerCase()))) {
        expect(text, 'an offered category matches the search').toContain(cats.p.name.toLowerCase().slice(0, 3));
      }
      await picker().locator(`[data-category-id="${cats.p.id}"]`).click();
      await expect(page.getByTestId('doc-category')).toContainText(cats.p.name);
      await expect.poll(async () => (await read(A)).categoryId, { message: 'the server recorded the category', timeout: 20_000 }).toBe(cats.p.id);

      await page.reload();
      await expect(page.getByTestId('doc-category')).toContainText(cats.p.name);
      // In the books: out of suspense, into the chosen category, total unchanged.
      await expectLedger(before, { [suspense!]: -centsOf(A), [cats.p.id]: centsOf(A) }, 0, 'categorize A');
    });

    test('categorize a PENDING-REVIEW document and mark it reviewed: the books change ONCE (when it gets a category), not again on review; the badge follows', async () => {
      test.setTimeout(180_000);
      const needsReviewBefore = (await docCounts(page)).needsReview;
      const before = await pnlSnapshot(page);
      await openDoc(B, { uncategorized: true, keepPicker: true });
      await picker().locator(`[data-category-id="${cats.x.id}"]`).click();
      await expect(page.getByTestId('doc-category')).toContainText(cats.x.name);
      await expect.poll(async () => (await read(B)).categoryId, { timeout: 20_000 }).toBe(cats.x.id);
      expect((await read(B)).journalEntryId, 'categorizing booked it').not.toBeNull();
      const afterCategorize = await expectLedger(before, { [cats.x.id]: centsOf(B) }, centsOf(B), 'categorize B');

      const reviewButton = page.getByRole('button', { name: t('mobile.docs.mark_reviewed'), exact: true });
      await expect(reviewButton).not.toHaveAttribute('aria-disabled', 'true');
      await reviewButton.click();
      await expect.poll(async () => (await read(B)).status, { timeout: 20_000 }).toBe('confirmed');
      await expect(page.getByText(t('mobile.docs.needs_review_banner'), { exact: true })).toHaveCount(0);
      await expect(reviewButton).toHaveCount(0);
      // Confirming posted no second entry: the P&L is exactly where categorizing left it.
      await expectLedger(afterCategorize, {}, 0, 'mark B reviewed');

      // The list and the tab badge follow: one fewer pending document.
      const needsReviewAfter = (await docCounts(page)).needsReview;
      expect(needsReviewAfter, 'pending-review count').toBe(needsReviewBefore - 1);
      await page.evaluate((key) => window.localStorage.removeItem(key), HOME_SNAPSHOT_STORAGE_KEY);
      const homeResponse = page.waitForResponse(isHomeGet, { timeout: 30_000 });
      await page.goto('/app/docs');
      const home = ((await (await homeResponse).json()) as { data: MobileHome }).data;
      await waitForHomeSnapshot(page, home.generatedAt);
      await settle(page);
      await expect(chipCount('needs-review')).toHaveText(String(needsReviewAfter));
      const expected = expectedDocsBadge(home, BADGES_ENABLED.docs);
      const badge = tabNav(page, t).locator('a[data-tab="/app/docs"] [data-badge="docs-count"]');
      if (expected > 0) await expect(badge).toHaveText(docsBadgeText(expected));
      else await expect(badge).toHaveCount(0);
    });

    test('RE-categorize a BOOKED document: the amount leaves the old category and lands in the new one in the P&L', async () => {
      test.setTimeout(150_000);
      expect((await read(C)).categoryId).toBe(cats.x.id);
      const before = await pnlSnapshot(page);
      await openDoc(C, { uncategorized: false });
      await page.getByRole('button', { name: t('mobile.docs.change_category'), exact: true }).click();
      await expect(picker()).toBeVisible();
      await expect(picker().locator(`[data-category-id="${cats.x.id}"]`), 'the current category is marked').toHaveAttribute('aria-pressed', 'true');
      await picker().locator(`[data-category-id="${cats.y.id}"]`).click();
      await expect(page.getByTestId('doc-category')).toContainText(cats.y.name);
      await expect.poll(async () => (await read(C)).categoryId, { timeout: 20_000 }).toBe(cats.y.id);
      await page.reload();
      await expect(page.getByTestId('doc-category')).toContainText(cats.y.name);
      // Needs the server fix that moves the journal line with the category (PR 4a): until it is deployed the row
      // says Y while the books still hold the amount under X, and this is the assertion that says so.
      await expectLedger(before, { [cats.x.id]: -centsOf(C), [cats.y.id]: centsOf(C) }, 0, 'recategorize C');
    });

    test('edit vendor and amount of a BOOKED document: both persist after reload, and the books change ONCE by the difference', async () => {
      test.setTimeout(150_000);
      const before = await pnlSnapshot(page);
      const newDollars = C.dollars + 7;
      const newVendor = `${tag} Gamma Edited`;
      await openDoc(C, { uncategorized: false });
      await page.getByLabel(t('mobile.docs.field_amount'), { exact: true }).fill(amountInputText(newDollars, locale));
      await page.getByLabel(t('mobile.docs.field_vendor'), { exact: true }).fill(newVendor);
      const save = page.getByTestId('save-changes');
      await expect(save).not.toHaveAttribute('aria-disabled', 'true');
      await save.click();
      await expect.poll(async () => (await read(C)).amountCents, { timeout: 20_000 }).toBe(newDollars * 100);
      expect((await read(C)).vendorName).toBe(newVendor);
      await expect(page.getByTestId('doc-amount')).toContainText(money(newDollars));

      await page.reload();
      await expect(page.getByTestId('doc-amount')).toContainText(money(newDollars));
      await expect(page.getByRole('heading', { level: 1, name: newVendor })).toBeVisible();
      await expect(page.getByLabel(t('mobile.docs.field_vendor'), { exact: true })).toHaveValue(newVendor);
      await expect(page.getByLabel(t('mobile.docs.field_amount'), { exact: true })).toHaveValue(amountInputText(newDollars, locale));
      // ONCE: the old amount was reversed and the new one posted, so the account moved by the difference, not by the new amount.
      await expectLedger(before, { [cats.y.id]: 700 }, 700, 'edit C amount');
      C = { ...C, vendor: newVendor, dollars: newDollars };
    });

    test('flip a BOOKED expense to personal: it leaves the business P&L; flipping back puts it there again', async () => {
      test.setTimeout(150_000);
      const before = await pnlSnapshot(page);
      await openDoc(C, { uncategorized: false });
      const personal = page.getByLabel(t('mobile.docs.personal_toggle'), { exact: true });
      await personal.click();
      await expect(personal).toBeChecked();
      await page.getByTestId('save-changes').click();
      await expect.poll(async () => (await read(C)).isPersonal, { timeout: 20_000 }).toBe(true);
      const personalState = await read(C);
      expect(personalState.journalEntryId, 'a personal expense is not on the books').toBeNull();
      const out = await expectLedger(before, { [cats.y.id]: -centsOf(C) }, -centsOf(C), 'C -> personal');

      await page.reload();
      await expect(page.getByLabel(t('mobile.docs.personal_toggle'), { exact: true })).toBeChecked();
      await page.getByLabel(t('mobile.docs.personal_toggle'), { exact: true }).click();
      await page.getByTestId('save-changes').click();
      await expect.poll(async () => (await read(C)).isPersonal, { timeout: 20_000 }).toBe(false);
      await expectLedger(out, { [cats.y.id]: centsOf(C) }, centsOf(C), 'C -> business again');
      // Net effect of the round trip on the books: none.
      const back = await pnlSnapshot(page);
      expect(back.totalExpensesCents, 'a round trip leaves the P&L where it started').toBe(before.totalExpensesCents);
      expect(expenseCentsFor(back, cats.y.id)).toBe(expenseCentsFor(before, cats.y.id));
    });

    test('archive: gone from the default list, still counted in every total; under Archived; restore brings it back; totals identical throughout', async () => {
      test.setTimeout(180_000);
      const totalsBefore = await totalsSnapshot(page);
      const archivedBefore = (await docCounts(page)).archived;
      await openDoc(C, { uncategorized: false });
      await page.getByRole('button', { name: t('mobile.docs.archive'), exact: true }).click();
      await expect(page.getByText(t('mobile.docs.archived_banner'), { exact: true })).toBeVisible();
      await expect.poll(async () => (await read(C)).archivedAt, { timeout: 20_000 }).not.toBeNull();
      expect(diffTotals(totalsBefore, await totalsSnapshot(page)), 'archive must not change any total').toEqual([]);

      await openList(`?q=${encodeURIComponent(tag)}`);
      await expect(rowOf(C), 'archived: hidden from the default list').toHaveCount(0);
      await expect(rowOf(D)).toHaveCount(1);
      await chip('archived').click();
      await expect(chipCount('archived')).toHaveText(String(archivedBefore + 1));
      await expect(rowOf(C)).toHaveCount(1);
      await expect(rowOf(C)).toContainText(money(C.dollars));
      await expect(rowOf(C)).toContainText(t('mobile.docs.archived_pill'));
      await rowOf(C).click();
      await expect(page.getByRole('heading', { level: 1, name: C.vendor })).toBeVisible();
      await page.getByRole('button', { name: t('mobile.docs.restore'), exact: true }).click();
      await expect(page.getByRole('button', { name: t('mobile.docs.archive'), exact: true })).toBeVisible();
      await expect.poll(async () => (await read(C)).archivedAt, { timeout: 20_000 }).toBeNull();
      expect(diffTotals(totalsBefore, await totalsSnapshot(page)), 'restore must not change any total').toEqual([]);
      expect((await docCounts(page)).archived, 'archived count is back').toBe(archivedBefore);

      await openList(`?q=${encodeURIComponent(tag)}`);
      await expect(rowOf(C), 'restored: back in the default list').toHaveCount(1);
    });

    // ── receipt image ─────────────────────────────────────────────────────────

    test('list thumbnail is served by the Next image optimizer and decodes', async () => {
      await openList(`?q=${encodeURIComponent(tag)}`);
      const thumb = rowOf(B).getByTestId('doc-thumb');
      await expect(thumb, 'a Blob receipt goes through the optimizer, not the plain-<img> fallback').toBeVisible();
      await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: 'thumbnail decoded' }).toBe(true);
      const src = await thumb.evaluate((i: HTMLImageElement) => i.currentSrc);
      expect(src).toContain('/_next/image');
      const res = await page.request.get(src);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toMatch(/^image\//);
    });

    test('a receipt image that fails to load shows "image unavailable" with Retry, and Retry loads it', async () => {
      test.setTimeout(120_000);
      const receiptUrl = (await read(B)).receiptUrl!;
      const base = receiptUrl.split('?')[0];
      // One function value for route AND unroute: Playwright matches a function matcher by identity.
      const isReceipt = (u: URL) => u.href.split('?')[0] === base;
      await page.route(isReceipt, (route) => route.abort());
      try {
        await page.goto(`/app/docs/${B.id}`);
        await expect(page.getByTestId('doc-amount')).toBeVisible();
        const failed = page.getByTestId('receipt-failed');
        await expect(failed).toBeVisible();
        await expect(failed).toContainText(t('mobile.docs.image_failed'));
        await expect(failed.getByRole('button', { name: t('mobile.docs.retry'), exact: true })).not.toHaveAttribute('aria-disabled', 'true');
      } finally {
        await page.unroute(isReceipt);
      }
      await page.getByTestId('receipt-failed').getByRole('button', { name: t('mobile.docs.retry'), exact: true }).click();
      await expect(page.getByTestId('receipt-failed')).toHaveCount(0);
      await expect(page.getByRole('img', { name: t('mobile.docs.receipt_alt') })).toBeVisible();
      const img = page.getByTestId('pinch-zoom-img');
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: 'receipt decoded after Retry' }).toBe(true);
    });

    // ── layout ────────────────────────────────────────────────────────────────

    test('grid view at 360 / 375 / 390 px: no horizontal overflow, every tile inside its column, more than one column', async () => {
      test.setTimeout(120_000);
      try {
        for (const width of [360, 375, 390]) {
          await page.setViewportSize({ width, height: MOBILE_VIEWPORT.height });
          await openList();
          // The saved view mode is applied after mount: wait for the list (long after that effect) before deciding whether to tap the toggle.
          const list = page.getByTestId('doc-list');
          await expect(list).toBeVisible();
          const toggle = page.getByRole('button', { name: t('mobile.docs.view_grid'), exact: true });
          if (await toggle.count()) await toggle.click();
          await expect(list).toHaveAttribute('data-view', 'grid');
          await expect(rows().first()).toBeVisible();
          const m = await page.evaluate(() => {
            const ul = document.querySelector('[data-testid="doc-list"]') as HTMLElement;
            const u = ul.getBoundingClientRect();
            const main = document.getElementById('mobile-main') as HTMLElement;
            const tiles = Array.from(ul.querySelectorAll('[data-testid="doc-item"]')).map((e) => {
              const r = e.getBoundingClientRect();
              return { left: r.left, right: r.right, overflow: (e as HTMLElement).scrollWidth - (e as HTMLElement).clientWidth };
            });
            const se = document.scrollingElement as HTMLElement;
            return {
              docOverflow: se.scrollWidth - se.clientWidth,
              mainOverflow: main.scrollWidth - main.clientWidth,
              vw: window.innerWidth,
              ul: { left: u.left, right: u.right },
              columns: getComputedStyle(ul).gridTemplateColumns.split(' ').length,
              tiles,
            };
          });
          expect(m.vw, 'the viewport is the width under test').toBe(width);
          expect(m.docOverflow, `${width}px: the page scrolls sideways`).toBeLessThanOrEqual(0);
          expect(m.mainOverflow, `${width}px: the content area scrolls sideways`).toBeLessThanOrEqual(0);
          expect(m.ul.left, `${width}px: list inside the viewport (left)`).toBeGreaterThanOrEqual(0);
          expect(m.ul.right, `${width}px: list inside the viewport (right)`).toBeLessThanOrEqual(width);
          expect(m.columns, `${width}px: grid columns`).toBeGreaterThanOrEqual(2);
          expect(m.tiles.length, 'tiles rendered').toBeGreaterThan(0);
          for (const [i, tile] of m.tiles.entries()) {
            expect(tile.left, `${width}px tile ${i} left edge`).toBeGreaterThanOrEqual(m.ul.left - 0.5);
            expect(tile.right, `${width}px tile ${i} right edge`).toBeLessThanOrEqual(m.ul.right + 0.5);
            expect(tile.overflow, `${width}px tile ${i} content overflows its tile`).toBeLessThanOrEqual(0);
          }
        }
      } finally {
        await page.setViewportSize(MOBILE_VIEWPORT);
        await page.evaluate(() => window.localStorage.removeItem('ab:mobile:docs:view')); // back to the list view for whatever runs next
      }
    });

    // ── offline (a real browser, no service worker: the app's own offline handling) ──

    test('OFFLINE list: a chip tap keeps the saved list and says so, without leaving the app; a search with no saved copy shows the honest offline state', async () => {
      test.setTimeout(150_000);
      await openList();
      // Visit the chip online so its list is saved, remember what it showed, then go back to All.
      await chip('no-receipt').click();
      await expect(chip('no-receipt')).toHaveAttribute('aria-pressed', 'true');
      const { total } = await listFilter(page, 'no-receipt');
      expect(total, 'D (and C) have no receipt, so this chip has rows to keep').toBeGreaterThan(0);
      await expect(results()).toHaveText(t('mobile.docs.results', { count: total }));
      await expect(rows().first()).toBeVisible();
      // The first page only: a later page loads on scroll and is not part of the saved first page.
      const firstPage = async () => (await rows().allInnerTexts()).slice(0, PAGE_SIZE);
      const savedRows = await firstPage();
      await chip('all').click();
      await expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('doc-list')).toBeVisible();
      await page.evaluate(() => { (window as unknown as { __abNoReload: string }).__abNoReload = 'kept'; });

      const TIME = '@@T@@';
      const kept = () => page.evaluate(() => (window as unknown as { __abNoReload?: string }).__abNoReload);
      try {
        await context.setOffline(true);
        await chip('no-receipt').click();
        await expect(chip('no-receipt')).toHaveAttribute('aria-pressed', 'true');
        const notice = page.getByTestId('docs-offline');
        await expect(notice).toBeVisible();
        await expect(notice).toHaveText(placeholderRegex(t('mobile.docs.offline_snapshot', { time: TIME }), TIME));
        // The saved list is still there: same rows, same text — not a blank, not the browser's offline page.
        expect(await firstPage(), 'the saved list is shown unchanged').toEqual(savedRows);
        await expect(page).toHaveURL((u) => u.pathname === '/app/docs' && u.searchParams.get('filter') === 'no-receipt');
        await expect(page.getByRole('heading', { name: t('common.documents') })).toBeVisible();
        expect(await kept(), 'a chip tap offline must not reload the page').toBe('kept');

        // Something never opened online has no saved copy: it says it is offline (with Retry), still inside the app.
        await page.getByRole('searchbox', { name: t('mobile.docs.search_label') }).fill(`ZZ${tag}`);
        const offlineState = page.getByRole('alert').filter({ hasText: t('mobile.kit.offline_title') });
        await expect(offlineState).toBeVisible();
        await expect(offlineState.getByRole('button', { name: t('mobile.docs.retry'), exact: true })).toBeVisible();
        expect(await kept(), 'a search offline must not reload the page').toBe('kept');
      } finally {
        await context.setOffline(false);
      }
      // Back online the list reloads by itself (or Retry does): the offline/stale notices go and the real list returns.
      await page.getByRole('searchbox', { name: t('mobile.docs.search_label') }).fill('');
      await expect(async () => {
        const stale = page.getByTestId('docs-stale');
        if ((await stale.count()) > 0) await stale.getByRole('button', { name: t('mobile.docs.retry'), exact: true }).click({ timeout: 2_000 }).catch(() => {});
        await expect(stale).toHaveCount(0, { timeout: 3_000 });
        await expect(page.getByTestId('docs-offline')).toHaveCount(0, { timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.getByTestId('doc-list')).toBeVisible();
    });

    test('OFFLINE viewer: fields are read-only, writes are inert, and Delete does nothing inside the already-open dialog', async () => {
      test.setTimeout(150_000);
      await openDoc(D, { uncategorized: false });
      // Open the delete dialog while online, THEN lose the connection: the confirm button must go inert in place.
      await page.getByTestId('delete-doc').click();
      const dialog = page.getByRole('dialog', { name: t('mobile.docs.delete_title') });
      await expect(dialog).toBeVisible();
      const deletes: string[] = [];
      const onRequest = (r: { method(): string; url(): string }) => {
        if (r.method() === 'DELETE') deletes.push(r.url());
      };
      page.on('request', onRequest);
      try {
        await context.setOffline(true);
        const confirm = dialog.getByTestId('confirm-delete');
        await expect(confirm).toHaveAttribute('aria-disabled', 'true');
        await confirm.click({ force: true });
        await page.waitForTimeout(800);
        await expect(dialog, 'the dialog stays open and nothing is deleted').toBeVisible();
        expect(deletes, 'no DELETE was attempted offline').toEqual([]);
        // Cancel still works offline.
        await dialog.getByRole('button', { name: t('mobile.docs.cancel'), exact: true }).click();
        await expect(dialog).toBeHidden();

        // The form: read-only inputs, inert Save / Archive / Delete / category, and the offline notice.
        // "You're offline" for live data, or "Offline — showing your copy saved at …" if the page was serving its saved copy.
        const TIME = '@@T@@';
        await expect(
          page.getByText(t('mobile.docs.offline_readonly'), { exact: true }).or(page.getByText(placeholderRegex(t('mobile.docs.offline_snapshot', { time: TIME }), TIME))).first(),
        ).toBeVisible();
        // (The note is the page's only textarea: its label's text includes the textarea's own text, so it has no exact label match.)
        const fields: Array<[string, Locator]> = [
          [t('mobile.docs.field_amount'), page.getByLabel(t('mobile.docs.field_amount'), { exact: true })],
          [t('mobile.docs.field_vendor'), page.getByLabel(t('mobile.docs.field_vendor'), { exact: true })],
          [t('mobile.docs.field_date'), page.getByLabel(t('mobile.docs.field_date'), { exact: true })],
          [t('mobile.docs.field_description'), page.locator('textarea')],
        ];
        for (const [label, field] of fields) {
          expect(await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => el.readOnly), `${label} is read-only offline`).toBe(true);
        }
        await expect(page.getByTestId('save-changes')).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByTestId('delete-doc')).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('button', { name: t('mobile.docs.archive'), exact: true })).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('button', { name: t('mobile.docs.change_category'), exact: true })).toHaveAttribute('aria-disabled', 'true');
        // What it shows is still the document.
        await expect(page.getByTestId('doc-amount')).toContainText(money(D.dollars));
      } finally {
        page.off('request', onRequest);
        await context.setOffline(false);
      }
      expect((await getExpense(page, D.id)).status, 'D still exists').toBe(200);
      // Back online the same controls work again.
      await expect(page.getByTestId('delete-doc')).not.toHaveAttribute('aria-disabled', 'true');
    });

    // ── delete (last: it takes a fixture off the books) ──────────────────────

    test('delete with confirmation: Cancel keeps it; confirming removes it from the list and the API and REVERSES it in the P&L', async () => {
      test.setTimeout(150_000);
      const a = await read(A);
      test.skip(a.categoryId === null && a.journalEntryId === null, 'fixture A is not booked (an earlier journey failed)');
      const before = await pnlSnapshot(page);
      await openDoc(A, { uncategorized: a.categoryId === null });
      await page.getByTestId('delete-doc').click();
      const dialog = page.getByRole('dialog', { name: t('mobile.docs.delete_title') });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(t('mobile.docs.delete_body'));
      await dialog.getByRole('button', { name: t('mobile.docs.cancel'), exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await getExpense(page, A.id)).status, 'Cancel deleted nothing').toBe(200);

      await page.getByTestId('delete-doc').click();
      await dialog.getByTestId('confirm-delete').click();
      await expect(page).not.toHaveURL(new RegExp(`/app/docs/${A.id}$`));
      await expect.poll(async () => (await getExpense(page, A.id)).status, { timeout: 20_000 }).toBe(404);
      await openList(`?q=${encodeURIComponent(tag)}`);
      await expect(rowOf(A)).toHaveCount(0);
      await expect(rowOf(D)).toHaveCount(1);
      // The books: A's debit was reversed (the account it sat in, and the total, drop by its amount).
      const account = a.categoryId ?? suspenseAccountId(before)!;
      const after = await pnlSnapshot(page);
      expect(accountDelta(before, after, account), 'A reversed out of its account').toBe(-centsOf(A));
      expect(after.totalExpensesCents - before.totalExpensesCents, 'total expenses fell by A').toBe(-centsOf(A));
    });

    test('totals invariant: after every journey is cleaned up, the persona\'s revenue, expenses, tax, month net, cash and P&L are exactly where they started', async () => {
      test.setTimeout(180_000);
      for (const id of created) await deleteExpenseQuietly(page, id);
      for (const id of created) expect((await getExpense(page, id)).status, `${id} is gone`).toBe(404);
      const after = await totalsSnapshot(page);
      expect(diffTotals(baseline, after), 'fields that did not return to their starting value').toEqual([]);
      // And nothing of this run is left in any list.
      await openList(`?q=${encodeURIComponent(tag)}`);
      await expect(rows()).toHaveCount(0);
      await chip('archived').click();
      await expect(rows()).toHaveCount(0);
    });
  });
}
