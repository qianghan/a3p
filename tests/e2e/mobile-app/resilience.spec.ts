import { test, expect } from './fixtures';
import type { Locator, Page, Route } from '@playwright/test';
import { MOBILE_VIEWPORT, catalogT, loginAs, pageLocales, settle, type CatalogT } from './helpers';
import { SEL } from './selectors';
import { inPageFetch } from './page-api';
import { amountInputText, makeReceiptJpeg, placeholderRegex } from './fixtures';
import { SNAPSHOT_PREFIX } from '../../../apps/web-next/src/lib/mobile/snapshot-keys';

/**
 * Spec 8.3 resilience: offline, slow network (3 s), API 500, 429 and an empty account on each screen.
 * Screenshots are attached for the launch report.
 *
 * strictErrors is OFF for this spec ONLY, and only for the browser's own "Failed to load resource" console lines:
 * an injected 500/429 (or the 404 of a deliberately unknown id) makes Chromium log one per request, which is the
 * browser describing the fault WE injected. Page errors and unhandled promise rejections still fail every test.
 *
 * Nothing here writes to the server. Every call that could create data (the capture screen's from-receipt upload and
 * the expense create the offline queue replays to) is answered by a route handler that NEVER continues to the
 * network, so the failures are injected and no expense can be booked. The one thing the capture journey creates is a
 * receipt in the browser's own IndexedDB queue, which it deletes before the device goes back online.
 *
 * Every UI string comes from the catalog (`catalogT`), and the catalog locale is PROVEN against the rendered page
 * before any test relies on it (Maya's tenant renders French in production).
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block', strictErrors: false });

const TOKEN = '@@TIME@@';
const CORE = '/api/v1/agentbook-core';
const EXPENSE = '/api/v1/agentbook-expense';

async function shot(page: Page, name: string) {
  await test.info().attach(`${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
}
const fulfillJson = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const isGet = (route: Route) => route.request().method() === 'GET';

/** Land on an /app page, read the string locale, and PROVE the catalog matches what is on screen. */
async function tFor(page: Page): Promise<CatalogT> {
  await page.goto('/app/docs');
  await expect(page.getByTestId(SEL.docs.screen)).toBeVisible();
  const loc = await pageLocales(page);
  const t = catalogT(loc.stringLocale);
  await expect(page.getByRole('heading', { level: 1 }), 'catalog locale does not match the rendered page').toHaveText(t('common.documents'));
  return t;
}
/** Forget every stored screen snapshot, so an error test sees an error and not a "last good" copy. */
async function clearSnapshots(page: Page) {
  await page.evaluate((prefix) => {
    try {
      for (const k of Object.keys(window.localStorage)) if (k.startsWith(prefix)) window.localStorage.removeItem(k);
    } catch { /* storage blocked */ }
  }, SNAPSHOT_PREFIX);
}

interface Screen {
  name: string;
  /** The path to open and the predicate for the ONE read this screen depends on. */
  open: (page: Page) => Promise<{ path: string; api: (u: URL) => boolean }>;
  /** Marks the real content (not merely the screen root, which renders while loading). */
  content: (page: Page) => Locator;
  loading: string;
  error: string;
  retry: (page: Page) => Locator;
  /** The title the error state must show (from the catalog), per injected condition. */
  errorTitle: (t: CatalogT, kind: '500' | '429') => string;
  /** The label that tells the user the device is offline and what they are looking at is a saved copy. */
  offlineMark: (page: Page, t: CatalogT) => Locator;
  offlineText: (t: CatalogT) => string | RegExp;
  /** The error test ids that must be absent once recovered. */
  errorIds: string[];
}

const timeRe = (rendered: string) => placeholderRegex(rendered, TOKEN);

const SCREENS: Screen[] = [
  {
    name: 'home',
    open: async () => ({ path: '/app', api: (u) => u.pathname === `${CORE}/mobile/home` }),
    content: (p) => p.getByTestId(SEL.home.kpiMonthNet),
    loading: SEL.home.skeleton,
    error: SEL.home.error,
    retry: (p) => p.getByTestId(SEL.home.error).getByRole('button').first(),
    errorTitle: (t, k) => (k === '429' ? t('mobile.home.error.rate_limited_title') : t('mobile.kit.error_title')),
    offlineMark: (p) => p.getByTestId(SEL.home.stale),
    offlineText: (t) => timeRe(t('mobile.kit.offline_as_of', { time: TOKEN })),
    errorIds: [SEL.home.error],
  },
  {
    name: 'docs',
    open: async () => ({ path: '/app/docs', api: (u) => u.pathname === `${EXPENSE}/expenses` }),
    content: (p) => p.getByTestId(SEL.docs.row).first(),
    loading: SEL.docs.skeleton,
    error: SEL.docs.error,
    retry: (p) => p.getByTestId(SEL.docs.error).getByRole('button').first(),
    errorTitle: (t) => t('mobile.docs.error_title'),
    offlineMark: (p) => p.getByTestId('docs-offline'),
    offlineText: (t) => timeRe(t('mobile.docs.offline_snapshot', { time: TOKEN })),
    errorIds: [SEL.docs.error],
  },
  {
    name: 'viewer',
    open: async (p) => {
      // READ-ONLY: the newest existing expense is only ever opened, never written.
      const list = await inPageFetch<{ data: Array<{ id: string }> }>(p, 'GET', `${EXPENSE}/expenses?limit=1`);
      const id = list.data?.data?.[0]?.id;
      expect(id, 'Maya has at least one expense to open').toBeTruthy();
      return { path: `/app/docs/${id}`, api: (u) => u.pathname === `${EXPENSE}/expenses/${id}` };
    },
    content: (p) => p.getByTestId(SEL.viewer.vendor),
    loading: SEL.viewer.skeleton,
    error: SEL.viewer.error,
    retry: (p) => p.getByTestId(SEL.viewer.error).getByRole('button').first(),
    errorTitle: (t) => t('mobile.docs.load_failed'),
    offlineMark: (p, t) => p.getByText(timeRe(t('mobile.docs.offline_snapshot', { time: TOKEN }))),
    offlineText: (t) => timeRe(t('mobile.docs.offline_snapshot', { time: TOKEN })),
    errorIds: [SEL.viewer.error],
  },
  {
    name: 'chat',
    open: async () => ({ path: '/app/chat', api: (u) => u.pathname.startsWith(`${CORE}/threads`) }),
    // The composer is on screen in EVERY chat state, so it proves nothing: "history loaded" is the empty state or a bubble.
    content: (p) =>
      p.locator(`[data-testid="${SEL.chat.empty}"], [data-testid="${SEL.chat.userBubble}"], [data-testid="${SEL.chat.botBubble}"]`).first(),
    loading: SEL.chat.loading,
    error: SEL.chat.error,
    retry: (p) => p.getByTestId('chat-history-retry'),
    errorTitle: (t) => t('mobile.chat.history_error'),
    offlineMark: (p) => p.getByTestId(SEL.chat.offline),
    offlineText: (t) => t('mobile.chat.offline_banner'),
    errorIds: [SEL.chat.error],
  },
];

test.describe('resilience (Maya)', () => {
  let t: CatalogT;

  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'maya');
    await settle(page);
    t = await tFor(page);
    await clearSnapshots(page);
  });

  for (const s of SCREENS) {
    test(`${s.name}: slow network (3 s) shows a loading state, then content`, async ({ page }) => {
      const { path, api } = await s.open(page);
      await page.route(
        (u) => api(u),
        async (route) => {
          if (!isGet(route)) return route.continue();
          await new Promise((r) => setTimeout(r, 3000));
          return route.continue().catch(() => undefined); // the test may have ended
        },
      );
      await page.goto(path, { waitUntil: 'commit' });
      await expect(page.getByTestId(s.loading).first()).toBeVisible({ timeout: 2500 });
      await shot(page, `${s.name}-slow-loading`);
      await expect(s.content(page)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(s.loading)).toHaveCount(0);
      for (const id of s.errorIds) await expect(page.getByTestId(id)).toHaveCount(0);
      await shot(page, `${s.name}-slow-loaded`);
    });

    test(`${s.name}: API 500 shows a labelled error with Retry that recovers`, async ({ page }) => {
      const { path, api } = await s.open(page);
      let fail = true;
      await page.route(
        (u) => api(u),
        (route) => (fail && isGet(route) ? fulfillJson(route, 500, { success: false, error: 'boom' }) : route.continue()),
      );
      await page.goto(path);
      const err = page.getByTestId(s.error);
      await expect(err).toBeVisible();
      await expect(err).toContainText(s.errorTitle(t, '500'));
      await expect(s.content(page)).toHaveCount(0); // an error is not a screen of zeros
      await shot(page, `${s.name}-500`);
      fail = false;
      await s.retry(page).click();
      await expect(s.content(page)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(s.loading)).toHaveCount(0);
      for (const id of s.errorIds) await expect(page.getByTestId(id)).toHaveCount(0);
    });

    test(`${s.name}: 429 is a labelled state, never a blank or a zero`, async ({ page }) => {
      const { path, api } = await s.open(page);
      await page.route(
        (u) => api(u),
        (route) =>
          isGet(route)
            ? fulfillJson(route, 429, { success: false, error: 'rate_limited', retryAfterMs: 3000, message: 'Too many requests' })
            : route.continue(),
      );
      await page.goto(path);
      const err = page.getByTestId(s.error);
      await expect(err).toBeVisible();
      await expect(err).toContainText(s.errorTitle(t, '429'));
      await expect(s.content(page)).toHaveCount(0);
      await shot(page, `${s.name}-429`);
    });

    test(`${s.name}: going offline after a good load keeps the content, labelled as a saved copy; back online clears the label`, async ({ page, context }) => {
      const { path } = await s.open(page);
      await page.goto(path);
      await expect(s.content(page)).toBeVisible();
      await expect(page.getByTestId(s.loading)).toHaveCount(0, { timeout: 15_000 });
      try {
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event('offline')));
        const mark = s.offlineMark(page, t);
        await expect(mark.first()).toBeVisible();
        await expect(mark.first()).toHaveText(s.offlineText(t));
        for (const id of s.errorIds) await expect(page.getByTestId(id)).toHaveCount(0);
        await expect(s.content(page)).toBeVisible(); // what was on screen stays on screen
        await shot(page, `${s.name}-offline`);
      } finally {
        await context.setOffline(false);
      }
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(s.offlineMark(page, t)).toHaveCount(0, { timeout: 20_000 });
      await expect(s.content(page)).toBeVisible();
    });
  }

  test('capture: upload 500 / 429 / slow 3 s show labelled states and offline queues; nothing reaches the server', async ({ page, context }) => {
    test.setTimeout(180_000);
    type Mode = '500' | '429' | 'slow';
    let mode: Mode = '500';
    let receiptHits = 0;
    // Every possible write is answered here and NEVER continued: the receipt upload, and the expense create a
    // queued item would replay to. So nothing in this test can book a record, whatever the app decides to do.
    await page.route(
      (u) => u.pathname === `${EXPENSE}/expenses/from-receipt`,
      async (route) => {
        receiptHits += 1;
        if (mode === '500') return fulfillJson(route, 500, { success: false, code: 'boom', error: 'boom' });
        if (mode === '429') return fulfillJson(route, 429, { success: false, error: 'rate_limited', retryAfterMs: 3000 });
        await new Promise((r) => setTimeout(r, 3000));
        return fulfillJson(route, 503, { success: false, error: 'boom' }).catch(() => undefined);
      },
    );
    await page.route(
      (u) => u.pathname === `${EXPENSE}/expenses`,
      (route) => (isGet(route) ? route.continue() : fulfillJson(route, 503, { success: false, error: 'blocked by test' })),
    );

    await page.goto('/app/capture');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('mobile.capture.title'));
    const locale = (await pageLocales(page)).formatLocale;
    const jpeg = await makeReceiptJpeg(page, 'resilience probe');
    const photo = { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: jpeg };
    const err = () => page.getByTestId(SEL.capture.error);
    const pick = async () => {
      await page.goto('/app/capture');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('mobile.capture.title'));
      await page.getByTestId(SEL.capture.fileInput).setInputFiles(photo);
    };
    const fillAndSave = async () => {
      const amount = page.getByTestId(SEL.capture.amount);
      await expect(amount).toBeVisible();
      await amount.fill(amountInputText(5, locale));
      await expect(page.getByTestId(SEL.capture.save)).toBeEnabled();
      await page.getByTestId(SEL.capture.save).click();
    };

    // 500: the photo-time read fails (labelled), and so does the save (labelled differently); no queue pill.
    mode = '500';
    await pick();
    await expect(err()).toContainText(t('mobile.capture.read_failed'));
    await shot(page, 'capture-500-read');
    await fillAndSave();
    await expect(err()).toContainText(t('mobile.capture.save_failed'));
    await expect(page.getByTestId(SEL.capture.queuePill)).toHaveCount(0);
    await shot(page, 'capture-500-save');

    // 429: same labelled failures; a throttled upload is not "queued" and not silently dropped.
    mode = '429';
    await pick();
    await expect(err()).toBeVisible();
    await fillAndSave();
    await expect(err()).toContainText(t('mobile.capture.save_failed'));
    await expect(page.getByTestId(SEL.capture.queuePill)).toHaveCount(0);
    await shot(page, 'capture-429');

    // Slow 3 s: the reading state shows and Save is held until it resolves.
    mode = 'slow';
    await pick();
    await expect(page.getByText(t('mobile.capture.reading'))).toBeVisible();
    await expect(page.getByTestId(SEL.capture.save)).toBeDisabled();
    await shot(page, 'capture-slow');
    await expect(page.getByText(t('mobile.capture.reading'))).toHaveCount(0, { timeout: 20_000 });
    await expect(err()).toBeVisible();
    expect(receiptHits, 'the upload route was only ever answered by the test').toBeGreaterThan(0);

    // Offline: the photo is kept and queued locally (IndexedDB), with a pill; nothing is sent.
    await page.goto('/app/capture');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('mobile.capture.title'));
    const hitsBeforeOffline = receiptHits;
    try {
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.getByTestId(SEL.capture.fileInput).setInputFiles(photo);
      await expect(page.getByText(t('mobile.capture.offline_mode'))).toBeVisible();
      await fillAndSave();
      await expect(page.getByTestId(SEL.capture.queuePill)).toHaveText(t('mobile.capture.queue_pill', { n: 1 }));
      expect(receiptHits, 'nothing was sent while offline').toBe(hitsBeforeOffline);
      await shot(page, 'capture-offline-queued');
    } finally {
      // Delete what THIS test queued BEFORE the device reconnects, so no replay is ever attempted. (Even if one
      // were, the route above would answer it.) Clear the stores in place: deleteDatabase would block on the
      // app's open connection, and opening a database that does not exist would create it empty.
      await page.evaluate(async () => {
        const dbs = (await (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases?.()) ?? [];
        if (!dbs.some((d) => d.name === 'agentbook-offline')) return;
        await new Promise<void>((resolve) => {
          const open = indexedDB.open('agentbook-offline');
          open.onerror = () => resolve();
          open.onsuccess = () => {
            const db = open.result;
            const stores = ['expense-queue', 'receipt-queue'].filter((n) => db.objectStoreNames.contains(n));
            if (stores.length === 0) { db.close(); resolve(); return; }
            const tx = db.transaction(stores, 'readwrite');
            for (const n of stores) tx.objectStore(n).clear();
            tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
          };
        });
      });
      await context.setOffline(false);
    }
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('mobile.capture.title'));
    await expect(page.getByTestId(SEL.capture.queuePill)).toHaveCount(0);
  });
});

test.describe('empty account (fresh)', () => {
  test('every screen shows its empty state, not an error or zeros; an unknown document is labelled not found', async ({ page }) => {
    await loginAs(page, 'fresh');
    await settle(page);
    const t = await tFor(page);
    for (const [path, id] of [
      ['/app', SEL.home.empty],
      ['/app/docs', SEL.docs.empty],
      ['/app/chat', SEL.chat.empty],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.locator('[data-testid$="-error"]')).toHaveCount(0);
      await shot(page, `fresh-${path.replace(/\//g, '_')}`);
    }
    await page.goto('/app/docs/not-a-real-id');
    await expect(page.getByTestId(SEL.viewer.error)).toContainText(t('mobile.docs.not_found'));
  });
});
