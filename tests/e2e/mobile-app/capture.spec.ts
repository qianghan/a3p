import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  catalogT,
  loginAs,
  loginUnavailableReason,
  newPersonaContext,
  pageLocales,
  settle,
  type CatalogT,
} from './helpers';
import {
  PERSONA_CURRENCY,
  amountInputText,
  countByQuery,
  deleteExpenseQuietly,
  diffTotals,
  getExpense,
  makeReceiptJpeg,
  moneyRegex,
  randomWholeDollars,
  runTag,
  totalsSnapshot,
  type Persona,
  type Totals,
} from './fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * Capture journeys (spec 8.1(7)(c)) per persona on a DEPLOYED site.
 *
 * - online: a real photo through the real file chooser -> OCR prefill -> Save -> exactly one expense, shown in Docs.
 * - offline: capture with the network cut -> "Queued" pill -> reconnect -> EXACTLY ONE expense, even when the replay
 *   is triggered more than once (the page's `online` handler; the service worker's Background Sync is blocked in this
 *   suite's config, so concurrent triggers are forced by re-dispatching `online` and reloading).
 * - manual: booked in the PERSONA'S currency, never the route's USD default.
 *
 * Cleanup: every expense a journey makes carries the persona's run tag in its vendor. Journeys sweep that tag in a
 * `finally` (so ids are tracked even when an assertion fails), afterAll sweeps again, and the last test proves the
 * persona's books are back exactly where they started.
 * Serial per persona: the offline journey counts expenses, which a concurrent writer would perturb.
 */
test.describe.configure({ mode: 'serial' });

for (const persona of ['maya', 'alex', 'sydney'] as Exclude<Persona, 'fresh'>[]) {
  test.describe(`capture - ${persona}`, () => {
    const currency = PERSONA_CURRENCY[persona];
    const tag = runTag(`E2ECAP${persona.slice(0, 2).toUpperCase()}`);
    const created: string[] = [];
    let context: BrowserContext;
    let page: Page;
    let t: CatalogT;
    let locale = 'en-US';
    let baseline: Totals;

    const rows = () => page.getByTestId('doc-item');
    const pill = () => page.getByTestId('queue-pill');
    const snapButton = () => page.getByRole('button', { name: t('mobile.capture.snap') });
    const saveButton = () => page.getByRole('button', { name: t('mobile.capture.save'), exact: true });
    const field = (key: 'mobile.capture.field_amount' | 'mobile.capture.field_vendor') => page.getByLabel(t(key), { exact: true });

    async function idsByQuery(q: string): Promise<string[]> {
      const res = await api(page).get(`/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(q)}&limit=100`);
      expectOk(res, `list q=${q}`);
      return (res.data.data as Array<{ id: string }>).map((r) => r.id);
    }
    async function totalExpenses(): Promise<number> {
      const res = await api(page).get('/api/v1/agentbook-expense/expenses?limit=1');
      expectOk(res, 'expense total');
      return res.data.meta.total as number;
    }
    /** Record every expense carrying this run's tag, so a failing assertion cannot leave one behind. */
    async function track(): Promise<string[]> {
      const ids = await idsByQuery(tag);
      for (const id of ids) if (!created.includes(id)) created.push(id);
      return ids;
    }
    async function snapPhoto(buffer: Buffer) {
      const chooser = page.waitForEvent('filechooser');
      await snapButton().click();
      await (await chooser).setFiles({ name: 'receipt.jpg', mimeType: 'image/jpeg', buffer });
    }
    async function openCapture() {
      await page.goto('/app/capture');
      await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
    }
    /** Open the Docs list filtered to `vendor`, with every amount past its "not loaded" dash. */
    async function openDocsFor(vendor: string) {
      await page.goto(`/app/docs?q=${encodeURIComponent(vendor)}`);
      await expect(rows().filter({ hasText: vendor })).toHaveCount(1);
      await expect(rows().locator('[data-money="none"]')).toHaveCount(0);
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const baseURL = testInfo.project.use.baseURL;
      const reason = loginUnavailableReason(baseURL);
      test.skip(reason !== null, reason ?? '');
      context = await newPersonaContext(browser, baseURL);
      page = await context.newPage();
      await loginAs(page, persona);
      await page.goto('/app/capture');
      await settle(page);
      const loc = await pageLocales(page);
      t = catalogT(loc.stringLocale);
      locale = loc.formatLocale;
      baseline = await totalsSnapshot(page);
    });

    test.afterAll(async () => {
      if (!page) return;
      try {
        await context.setOffline(false);
        // A replay that was still pending (a failed offline journey) must land BEFORE the sweep, or it books an
        // expense after the cleanup. Best effort: the page may already be gone.
        await page.goto('/app/capture');
        await expect(pill()).toHaveCount(0, { timeout: 30_000 });
      } catch {
        /* sweep anyway */
      }
      try {
        await track();
      } catch {
        /* sweep what is already tracked */
      }
      for (const id of created) await deleteExpenseQuietly(page, id);
      await context.close();
    });

    test('online: photo -> prefilled -> save -> exactly one expense, listed in Docs in the tenant currency; thumbnail is optimizer-served', async () => {
      test.setTimeout(150_000);
      const vendor = `${tag} Online`;
      const dollars = randomWholeDollars();
      try {
        await openCapture();
        await expect(page.getByTestId('capture-file')).toHaveAttribute('capture', 'environment');
        await snapPhoto(await makeReceiptJpeg(page, vendor));
        await expect(page.getByRole('img', { name: t('mobile.capture.preview_alt') })).toBeVisible();
        await expect(page.getByText(t('mobile.capture.uploaded_hint'))).toBeVisible({ timeout: 60_000 }); // real OCR
        await field('mobile.capture.field_amount').fill(amountInputText(dollars, locale));
        await field('mobile.capture.field_vendor').fill(vendor);
        await saveButton().click();
        await expect(snapButton()).toBeVisible(); // back on the camera-ready screen

        expect(await idsByQuery(vendor), 'exactly one expense for this capture').toHaveLength(1);
        const [id] = await track();
        await openDocsFor(vendor);
        await expect(rows().filter({ hasText: vendor })).toContainText(moneyRegex(dollars, currency, locale));

        const one = await getExpense(page, id);
        expectOk(one, 'read captured expense');
        expect(one.data.data.amountCents).toBe(dollars * 100);
        const url = one.data.data.receiptUrl as string;
        expect(url).toMatch(/^https:\/\/[^/]+\.vercel-storage\.com\//);
        const img = await page.request.get(`/_next/image?url=${encodeURIComponent(url)}&w=96&q=60`);
        expect(img.status()).toBe(200);
        expect(img.headers()['content-type']).toMatch(/^image\//);
      } finally {
        await track().catch(() => undefined);
      }
    });

    test('offline: queue pill -> reconnect -> exactly one new expense, however many times the replay fires', async () => {
      test.setTimeout(150_000);
      const vendor = `${tag} Offline`;
      const dollars = randomWholeDollars();
      try {
        await openCapture();
        const jpeg = await makeReceiptJpeg(page, vendor);
        const totalBefore = await totalExpenses();
        expect(await countByQuery(page, vendor)).toBe(0);

        await context.setOffline(true);
        await snapPhoto(jpeg);
        await expect(page.getByText(t('mobile.capture.offline_mode'))).toBeVisible();
        await field('mobile.capture.field_amount').fill(amountInputText(dollars, locale));
        await field('mobile.capture.field_vendor').fill(vendor);
        await saveButton().click();
        await expect(pill()).toHaveText(t('mobile.capture.queue_pill', { n: 1 }));
        // Nothing reached the server while offline.
        await context.setOffline(false);
        // Fire the page's replay trigger several times at once: the stored idempotency key must make it one expense.
        await page.evaluate(() => {
          for (let i = 0; i < 3; i += 1) window.dispatchEvent(new Event('online'));
        });
        await expect(pill()).toHaveCount(0, { timeout: 45_000 });
        await expect.poll(() => countByQuery(page, vendor), { timeout: 45_000 }).toBe(1);

        // Another replay opportunity after the queue drained (the shell remounts and re-runs its replay): still one.
        await page.reload();
        await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForLoadState('networkidle');
        await expect(pill()).toHaveCount(0);
        expect(await countByQuery(page, vendor), 'exactly one expense for this receipt').toBe(1);
        expect(await totalExpenses(), 'the persona gained exactly one expense').toBe(totalBefore + 1);

        await track();
        await openDocsFor(vendor);
        await expect(rows().filter({ hasText: vendor })).toContainText(moneyRegex(dollars, currency, locale));
      } finally {
        await context.setOffline(false);
        await track().catch(() => undefined);
      }
    });

    test('manual entry is booked in the tenant currency, not USD', async () => {
      const vendor = `${tag} Manual`;
      const dollars = randomWholeDollars();
      try {
        await openCapture();
        await page.getByRole('button', { name: t('mobile.capture.manual') }).click();
        await field('mobile.capture.field_amount').fill(amountInputText(dollars, locale));
        await field('mobile.capture.field_vendor').fill(vendor);
        await saveButton().click();
        await expect(snapButton()).toBeVisible();
        await expect.poll(() => countByQuery(page, vendor), { timeout: 20_000 }).toBe(1);
        const [id] = await idsByQuery(vendor);
        await track();
        const one = await getExpense(page, id);
        expectOk(one, 'read manual expense');
        expect(one.data.data.currency).toBe(currency);
        expect(one.data.data.amountCents).toBe(dollars * 100);

        await openDocsFor(vendor);
        await expect(rows().filter({ hasText: vendor })).toContainText(moneyRegex(dollars, currency, locale));
        await expect(rows().filter({ hasText: vendor }).locator(`[data-money="${currency}"]`)).toHaveCount(1);
      } finally {
        await track().catch(() => undefined);
      }
    });

    test("totals invariant: after every journey is cleaned up, the persona's books are exactly where they started", async () => {
      test.setTimeout(180_000);
      await context.setOffline(false);
      await track();
      for (const id of created) await deleteExpenseQuietly(page, id);
      for (const id of created) expect((await getExpense(page, id)).status, `${id} is gone`).toBe(404);
      expect(await idsByQuery(tag), 'nothing of this run is left in the list').toHaveLength(0);
      const after = await totalsSnapshot(page);
      expect(diffTotals(baseline, after), 'fields that did not return to their starting value').toEqual([]);
    });
  });
}
