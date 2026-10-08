import { test, expect, type Locator, type Page, type Response } from '@playwright/test';
import type { MobileAlert, MobileHome } from '../../../apps/web-next/src/lib/mobile/types';
import { alertCopy } from '../../../apps/web-next/src/app/app/_lib/alert-copy';
import { BADGES_ENABLED } from '../../../apps/web-next/src/app/app/_shell/badges';
import {
  loginAs,
  settle,
  pageLocales,
  catalogT,
  money,
  clockTime,
  calendarDay,
  expectScreen,
  tabNav,
  loginUnavailableReason,
  applySafeAreaInsets,
  measureShell,
  waitForHomeSnapshot,
  HOME_SNAPSHOT_STORAGE_KEY,
  IPHONE_INSETS,
  MOBILE_VIEWPORT,
  PERSONAS,
} from './helpers';

/**
 * The PWA Home (PR 3) against a DEPLOYED site, across the persona matrix:
 * maya (CA/CAD), alex (US/USD), sydney (AU/AUD) and a brand-new account.
 *
 * Every expectation is computed from the /mobile/home response THE PAGE ITSELF
 * consumed (the response is awaited with waitForResponse registered BEFORE the
 * navigation, as shell.spec's badge journey does) and from the app's own
 * catalog + formatters — no seeded amount is ever hardcoded, so a re-seed or a
 * day's drift in the live books does not break the suite, while a page that
 * renders the wrong sentence, figure or currency does.
 */

const HOME_PATH = '/api/v1/agentbook-core/mobile/home';
const CHAT_MESSAGE_PATH = '/api/v1/agentbook-core/agent/message';
/** The banner shows at most this many alerts (MAX_ALERTS in _home/AlertCarousel.tsx — a React module Playwright cannot import). */
const MAX_ALERTS = 5;
const MAX_NEXT_UP = 3;
const MAX_RECENT = 5;
const REMIND_ENDPOINT = /^\/api\/v1\/agentbook-invoice\/invoices\/[\w-]+\/remind$/;

const isHomeGet = (r: Response): boolean => new URL(r.url()).pathname === HOME_PATH && r.request().method() === 'GET';

/**
 * Open Home and return what the page itself was given. The response listener is
 * registered before the navigation (a response that arrives during goto would
 * otherwise be missed), the body is the SAME one the screen and the tab bar used,
 * and the call returns only after the app has stored that response's snapshot
 * (so "no badge" checks made afterwards are observations, not races).
 */
async function openHome(page: Page) {
  const homeResponse = page.waitForResponse(isHomeGet, { timeout: 30_000 });
  await page.goto('/app');
  const res = await homeResponse;
  expect(res.status(), 'mobile/home status').toBe(200);
  const home = ((await res.json()) as { data: MobileHome }).data;
  await waitForHomeSnapshot(page, home.generatedAt);
  await settle(page);
  const { stringLocale, formatLocale } = await pageLocales(page);
  const t = catalogT(stringLocale);
  const fmt = (cents: number) => money(cents, home.currency, formatLocale);
  return { t, home, fmt, formatLocale };
}

function currencySymbol(currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(1).find((p) => p.type === 'currency')!.value;
}

/** The slide for alert `index` (0-based among the shown alerts), selected the way a user does: its dot. */
async function showAlert(page: Page, t: ReturnType<typeof catalogT>, total: number, index: number): Promise<Locator> {
  if (total > 1) {
    await page.getByRole('button', { name: t('mobile.home.alert_dot', { index: index + 1, total }), exact: true }).click();
  }
  return page.getByTestId('alert-carousel');
}

/** "invoice_overdue+action, review_needed→/app/docs" — what a persona's banner could exercise. */
function describeKinds(alerts: MobileAlert[]): string {
  if (alerts.length === 0) return 'none';
  return alerts
    .slice(0, MAX_ALERTS)
    .map((a) => `${a.kind}${a.action ? '+action' : a.target ? `→${a.target.route}` : ''}`)
    .join(', ');
}

const KPIS = [
  ['month_net', 'monthNetCents'],
  ['cash', 'cashTodayCents'],
  ['outstanding', 'outstandingCents'],
  ['tax', 'estTaxOwedCents'],
] as const;

/** US-only tax wording that must never reach an Australian user. */
const US_ONLY_WORDING = /self-employment|Schedule C|Schedule SE|1040-ES/i;

test.describe('@mobile-home', () => {
  // A local dev server has no seeded personas; say so instead of failing on a login that cannot work.
  test.beforeEach(({ baseURL }) => {
    const reason = loginUnavailableReason(baseURL);
    test.skip(reason !== null, reason ?? '');
  });

  for (const persona of ['maya', 'alex', 'sydney'] as const) {
    test.describe(persona, () => {
      test('sections in order; banner text, the four KPI amounts and every figure in the tenant currency', async ({ page }) => {
        await loginAs(page, persona);
        const { t, home, fmt, formatLocale } = await openHome(page);
        expect(home.currency, `${persona} tenant currency`).toBe(PERSONAS[persona].currency);
        expect(home.isBrandNew, `${persona} is a seeded persona with books`).toBe(false);

        const main = page.locator('main');
        const region = page.getByRole('region', { name: t('mobile.home.kpi.region') });
        await expect(region).toBeVisible();

        // KPI strip: label + value per tile; a figure that does not exist renders the labelled dash, never a made-up number.
        for (const [id, field] of KPIS) {
          const tile = region.locator(`[data-kpi="${id}"]`);
          await expect(tile).toContainText(t(`mobile.home.kpi.${id}`));
          const cents = home.kpis[field];
          if (cents === null) {
            await expect(tile.locator('[data-money="none"]'), `${id} has no figure`).toHaveCount(1);
            await expect(tile).toContainText('—');
          } else {
            await expect(tile).toContainText(fmt(cents));
          }
        }
        // The overdue sub-line exists exactly when there are overdue invoices, and says the server's count and amount.
        const sub = region.locator('[data-kpi="outstanding"] [data-kpi-sub]');
        if (home.kpis.overdueCount > 0) {
          await expect(sub).toContainText(t('mobile.home.kpi.overdue_sub', { count: home.kpis.overdueCount, amount: fmt(home.kpis.overdueCents) }));
        } else {
          await expect(sub).toHaveCount(0);
        }

        // Currency: the jurisdiction's own symbol, and no figure on the page in any other currency.
        expect(await region.locator('[data-kpi="outstanding"]').innerText()).toContain(currencySymbol(home.currency, formatLocale));
        const currencies = await main.locator('[data-money]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-money')))]);
        expect(currencies.length, 'the page renders money').toBeGreaterThan(0);
        for (const c of currencies) expect([home.currency, 'none'], `a figure rendered in ${c}`).toContain(c);

        // Banner: the app's own sentence for the first (highest-ranked) alert, or no banner at all.
        const carousel = page.getByTestId('alert-carousel');
        const shown = home.alerts.slice(0, MAX_ALERTS);
        if (shown.length > 0) {
          await expect(carousel).toContainText(alertCopy(shown[0], t, fmt).title);
          await expect(carousel).toHaveAttribute('data-alert-id', shown[0].id);
          if (shown.length > 1) {
            await expect(page.getByRole('button', { name: t('mobile.home.alert_dot', { index: 1, total: shown.length }), exact: true })).toHaveAttribute('aria-current', 'true');
          }
        } else {
          await expect(carousel).toHaveCount(0);
        }

        // Next up (≤3) and Recent activity (≤5): server order and server figures.
        const nextUp = home.nextUp.slice(0, MAX_NEXT_UP);
        await expect(main.getByRole('heading', { level: 2, name: t('mobile.home.next_up.title'), exact: true })).toBeVisible();
        await expect(main.locator('li[data-next-up]')).toHaveCount(nextUp.length);
        if (nextUp.length === 0) await expect(main.getByText(t('mobile.home.next_up.empty'), { exact: true })).toBeVisible();
        for (const [i, u] of nextUp.entries()) {
          const row = main.locator('li[data-next-up]').nth(i);
          await expect(row).toContainText(calendarDay(u.date, formatLocale));
          if (u.amountCents !== null) await expect(row).toContainText(fmt(u.amountCents));
        }
        const recent = home.recent.slice(0, MAX_RECENT);
        await expect(main.getByRole('heading', { level: 2, name: t('mobile.home.recent.title'), exact: true })).toBeVisible();
        await expect(main.locator('li[data-recent]')).toHaveCount(recent.length);
        if (recent.length === 0) await expect(main.getByText(t('mobile.home.recent.empty'), { exact: true })).toBeVisible();
        for (const [i, r] of recent.entries()) {
          const row = main.locator('li[data-recent]').nth(i);
          await expect(row).toContainText(r.label);
          await expect(row).toContainText(fmt(r.amountCents));
        }
        await expect(main.getByRole('heading', { level: 2, name: t('mobile.home.quick.title'), exact: true })).toBeVisible();

        // Order on screen: banner → KPIs → next up → recent → quick actions.
        const tops = async (loc: Locator) => (await loc.boundingBox())!.y;
        const ys = [
          ...(shown.length > 0 ? [await tops(carousel)] : []),
          await tops(region),
          await tops(main.getByRole('heading', { level: 2, name: t('mobile.home.next_up.title'), exact: true })),
          await tops(main.getByRole('heading', { level: 2, name: t('mobile.home.recent.title'), exact: true })),
          await tops(main.getByRole('heading', { level: 2, name: t('mobile.home.quick.title'), exact: true })),
        ];
        expect(ys, 'sections stack in order').toEqual([...ys].sort((a, b) => a - b));

        if (persona === 'sydney') {
          await expect(main).not.toContainText(US_ONLY_WORDING);
        }

        // Tab badges (the shell's own request is the one this response was shared with; the snapshot wait in
        // openHome means the tab bar has already used it): the Home dot iff a critical alert exists, and the
        // Docs badge absent while its gate is off.
        const nav = tabNav(page, t);
        const critical = BADGES_ENABLED.home && home.alerts.some((a) => a.severity === 'critical');
        test.info().annotations.push({ type: 'home-dot', description: critical ? 'positive: a critical alert exists, dot expected' : 'zero: no critical alert, no dot expected' });
        await expect(nav.locator('a[data-tab="/app"] [data-badge="home-dot"]')).toHaveCount(critical ? 1 : 0, { timeout: 10_000 });
        if (!BADGES_ENABLED.docs) {
          await expect(nav.locator('a[data-tab="/app/docs"] [data-badge="docs-count"]')).toHaveCount(0);
        }
      });

      test('every banner action is present and every banner link lands on a working /app screen', async ({ page }) => {
        // Up to 5 × (goto + settle's 2 s + screen render + the 1.5 s no-auto-send window) against production.
        test.setTimeout(180_000);
        await loginAs(page, persona);
        const first = await openHome(page);
        const count = first.home.alerts.slice(0, MAX_ALERTS).length;
        // Which branches this persona really had, so a green run says what it covered.
        test.info().annotations.push({ type: 'alert-kinds', description: describeKinds(first.home.alerts) });
        test.skip(count === 0, `${persona} has no Home alerts on this deployment (the collective gate test at the end FAILS if no persona has an overdue-invoice-with-action alert or a target-link alert)`);

        for (let i = 0; i < count; i++) {
          // A fresh load per alert: nothing carries over from the previous screen, and the expectation is
          // always computed from the response THIS load rendered.
          const { t, home, fmt } = i === 0 ? first : await openHome(page);
          const visible = home.alerts.slice(0, MAX_ALERTS);
          const alert: MobileAlert | undefined = visible[i];
          if (!alert) break; // the live books changed between loads; what was there has been checked
          await expect(page.getByRole('region', { name: t('mobile.home.kpi.region') })).toBeVisible();
          const carousel = await showAlert(page, t, visible.length, i);
          const copy = alertCopy(alert, t, fmt);
          await expect(carousel).toHaveAttribute('data-alert-id', alert.id);
          await expect(carousel).toContainText(copy.title);
          expect(copy.actionLabel, `${alert.kind}: the banner offers an action`).not.toBeNull();

          if (alert.action) {
            // In-place action (Remind). Presence + shape only here: the one real click per run is the dedicated test below.
            expect(alert.action.endpoint, `${alert.kind} endpoint`).toMatch(REMIND_ENDPOINT);
            expect(alert.action.labelKey).toBe('mobile.alerts.action_remind');
            const button = carousel.locator('[data-alert-action="post"]');
            await expect(button).toHaveText(copy.actionLabel!);
            await expect(button).not.toHaveAttribute('aria-disabled', 'true');
          } else {
            expect(alert.target?.route, `${alert.kind} must target the mobile app`).toMatch(/^\/app(\/|$)/);
            expect(copy.href, `${alert.kind} link`).not.toBeNull();
            const link = carousel.getByRole('link', { name: copy.actionLabel!, exact: true });
            await expect(link).toHaveAttribute('href', copy.href!);

            // A chat target is a PREFILL, never a message the app sends on the user's behalf.
            const sent: string[] = [];
            const onRequest = (r: { url(): string; method(): string }) => {
              if (new URL(r.url()).pathname === CHAT_MESSAGE_PATH && r.method() === 'POST') sent.push(r.url());
            };
            page.on('request', onRequest);
            await link.click();
            await page.waitForURL((u) => u.pathname === alert.target!.route);
            for (const [k, v] of Object.entries(alert.target!.query ?? {})) {
              expect(new URL(page.url()).searchParams.get(k), `query ${k}`).toBe(v);
            }
            await expectScreen(page, alert.target!.route, t);
            let composerValue: string | null = null;
            if (alert.target!.route === '/app/chat') {
              const composer = page.locator('#mobile-main').locator('textarea, input[type="text"], input:not([type]), [role="textbox"]').first();
              await expect(composer, 'chat has a text input').toBeVisible();
              composerValue = await composer.inputValue();
            }
            await page.waitForTimeout(1_500); // an auto-send would fire shortly after the screen mounts
            page.off('request', onRequest);
            expect(sent, `${alert.kind}: landing on ${alert.target!.route} must not send a chat message`).toEqual([]);
            if (alert.target!.route === '/app/chat') {
              // The topic is a PREFILL: whatever the composer was given is still sitting there, unsent.
              // The chat does not read ?topic= yet (PR 6 Task 6.9 builds the prefill, and there is no catalog
              // string for it to compare with), so today the composer is empty; when 6.9 lands it must replace
              // this annotation with an exact assertion of the topic's catalog question.
              const composer = page.locator('#mobile-main').locator('textarea, input[type="text"], input:not([type]), [role="textbox"]').first();
              expect(await composer.inputValue(), `${alert.kind}: a prefill must still be in the composer, not consumed by a send`).toBe(composerValue);
              test.info().annotations.push({
                type: 'chat-prefill',
                description: composerValue ? `${alert.kind}: composer prefilled (${composerValue.length} chars), unsent` : `${alert.kind}: composer empty (prefill is PR 6 Task 6.9), nothing sent`,
              });
            }
          }
        }
      });

      test('KPI sheets open with their own numbers and mobile links only', async ({ page }) => {
        await loginAs(page, persona);
        const { t, home, fmt, formatLocale } = await openHome(page);
        const region = page.getByRole('region', { name: t('mobile.home.kpi.region') });
        await expect(region).toBeVisible();

        for (const [id, field] of KPIS) {
          await region.locator(`[data-kpi="${id}"]`).click();
          const sheet = page.getByRole('dialog', { name: t(`mobile.home.kpi.${id}`), exact: true });
          await expect(sheet).toBeVisible();
          const cents = home.kpis[field];
          await expect(sheet).toContainText(cents === null ? '—' : fmt(cents));

          if (id === 'outstanding') {
            // dl = overdue count, then overdue amount: the server's own figures.
            await expect(sheet.locator('dt').nth(0)).toHaveText(t('mobile.home.kpi.overdue_count'));
            await expect(sheet.locator('dd').nth(0)).toHaveText(String(home.kpis.overdueCount));
            await expect(sheet.locator('dt').nth(1)).toHaveText(t('mobile.home.kpi.overdue_amount'));
            await expect(sheet.locator('dd').nth(1)).toContainText(fmt(home.kpis.overdueCents));
            const overdue = home.alerts.filter((a) => a.kind === 'invoice_overdue');
            await expect(sheet.getByRole('list', { name: t('mobile.home.kpi.overdue_list') }).locator('li')).toHaveCount(overdue.length);
            // A banner list capped below the real count says so instead of looking complete.
            await expect(sheet.locator('[data-overdue-partial]')).toHaveCount(overdue.length < home.kpis.overdueCount ? 1 : 0);
          } else if (id === 'tax') {
            await expect(sheet).toContainText(cents === null ? t('mobile.home.kpi.tax_unavailable') : t('mobile.home.kpi.tax_help'));
            const next = home.nextUp.find((u) => u.kind === 'tax');
            if (next) await expect(sheet.locator('[data-next-tax]')).toContainText(t('mobile.home.kpi.next_tax_on', { date: calendarDay(next.date, formatLocale) }));
            else await expect(sheet.locator('[data-next-tax]')).toHaveCount(0);
          } else if (id === 'cash') {
            await expect(sheet).toContainText(cents === null ? t('mobile.home.kpi.cash_unavailable') : t('mobile.home.kpi.cash_help'));
          } else {
            await expect(sheet).toContainText(cents === null ? t('mobile.home.kpi.month_net_unavailable') : t('mobile.home.kpi.month_net_help'));
          }

          // No desktop link, ever (spec principle 4).
          for (const href of await sheet.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
            expect(href, `${id} sheet link`).toMatch(/^\/app(\/|$|\?)/);
          }
          if (persona === 'sydney') await expect(sheet).not.toContainText(US_ONLY_WORDING);

          await page.keyboard.press('Escape');
          await expect(sheet).toHaveCount(0);
        }
      });
    });
  }

  test('maya: quick actions open their screens', async ({ page }) => {
    await loginAs(page, 'maya');
    const { t } = await openHome(page);
    await expect(page.getByRole('region', { name: t('mobile.home.kpi.region') })).toBeVisible();
    // "Add expense" shares Capture with "Snap receipt" until PR 5 gives Capture a manual-entry mode.
    const quick = [
      ['snap', 'mobile.home.quick.snap', '/app/capture'],
      ['add', 'mobile.home.quick.add_expense', '/app/capture'],
      ['ask', 'mobile.home.quick.ask', '/app/chat'],
    ] as const;
    expect(await page.locator('main a[data-quick]').evaluateAll((els) => els.map((e) => e.getAttribute('data-quick')))).toEqual(quick.map((q) => q[0]));
    for (const [id, labelKey, route] of quick) {
      await page.goto('/app');
      const link = page.locator(`main a[data-quick="${id}"]`);
      await expect(link).toContainText(t(labelKey));
      await expect(link).toHaveAttribute('href', route);
      await link.click();
      await page.waitForURL((u) => u.pathname === route);
      await expectScreen(page, route, t);
    }
  });

  test('maya: Refresh re-reads the live numbers (the touch-only pull gesture is not driven here)', async ({ page }) => {
    await loginAs(page, 'maya');
    const { t } = await openHome(page);
    const region = page.getByRole('region', { name: t('mobile.home.kpi.region') });
    await expect(region).toBeVisible();
    const again = page.waitForResponse(isHomeGet, { timeout: 30_000 });
    await page.getByRole('button', { name: t('mobile.home.refresh'), exact: true }).click();
    expect((await again).status(), 'refresh request').toBe(200);
    await expect(region).toBeVisible();
    await expect(page.getByTestId('stale-notice')).toHaveCount(0);
    await expect(page.getByTestId('home-error')).toHaveCount(0);
  });

  // Its own describe so retries can be switched off for it alone: the config's `retries: 1` would otherwise
  // re-run a failure that happened AFTER the click and send a second real POST (a second logged reminder on
  // a seeded invoice). One click per run means one attempt.
  test.describe('remind', () => {
    test.describe.configure({ retries: 0 });

    test('Remind on ONE overdue invoice: "Logged" at once, the toast only after the POST resolves', async ({ page }) => {
      // The remind route only LOGS the reminder (delivered:false, email deferred) and bumps lastRemindedAt,
      // so it is harmless to repeat; still, exactly one click on one alert per run, and none at all when no
      // seeded persona has an overdue invoice (the collective gate test then fails the run instead).
      let chosen: { persona: 'maya' | 'alex' | 'sydney'; ctx: Awaited<ReturnType<typeof openHome>>; index: number } | null = null;
      for (const persona of ['maya', 'alex', 'sydney'] as const) {
        await page.context().clearCookies();
        await loginAs(page, persona);
        const ctx = await openHome(page);
        const shown = ctx.home.alerts.slice(0, MAX_ALERTS);
        const index = shown.findIndex((a) => a.kind === 'invoice_overdue' && a.action);
        if (index !== -1) {
          chosen = { persona, ctx, index };
          break;
        }
      }
      test.skip(chosen === null, 'no seeded persona has an overdue-invoice alert on this deployment: nothing to remind (the collective gate test fails this run)');
      const { persona, ctx, index } = chosen!;
      const { t, home, fmt } = ctx;
      const shown = home.alerts.slice(0, MAX_ALERTS);
      const alert = shown[index];
      const endpoint = alert.action!.endpoint;
      test.info().annotations.push({ type: 'remind-persona', description: persona });

      await expect(page.getByRole('region', { name: t('mobile.home.kpi.region') })).toBeVisible();
      const carousel = await showAlert(page, t, shown.length, index);
      await expect(carousel).toContainText(alertCopy(alert, t, fmt).title);
      const button = carousel.locator('[data-alert-action="post"]');
      expect(alert.action!.labelKey).toBe('mobile.alerts.action_remind');
      await expect(button).toHaveText(t(alert.action!.labelKey));

      const isRemind = (r: { method(): string; url(): string }) => r.method() === 'POST' && new URL(r.url()).pathname === endpoint;
      const posts: string[] = [];
      page.on('request', (r) => {
        if (isRemind(r)) posts.push(r.url());
      });
      // Hold the POST in flight: this is the window in which the toast must NOT exist yet. (route.continue
      // sends the real request once released: it is the run's one reminder.)
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      await page.route((u) => u.pathname === endpoint, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        held = true;
        await gate;
        await route.continue();
      });
      // Registered BEFORE the click so a fast response cannot be missed.
      const posted = page.waitForResponse((r) => isRemind(r.request()), { timeout: 60_000 });
      const toast = page.getByRole('status', { name: t('mobile.kit.notifications') });
      const logged = t('mobile.home.toast.reminder_logged');

      await button.click();
      // Optimistic: the button is already the "Logged" state (nothing is delivered, so never "Reminded"), and inert, while the POST is still held.
      await expect(button).toHaveText(t('mobile.home.action.logged'));
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect.poll(() => held, { message: 'the remind POST reached the network layer', timeout: 10_000 }).toBe(true);
      // Sampled, not `expect(...).not.toContainText`: that matcher RETRIES until the text is gone, and a toast
      // that fired early disappears after 3.5 s, so it would pass against exactly the bug it guards.
      for (let i = 0; i < 6; i++) {
        expect(await toast.textContent(), `no toast of any kind while the POST is pending (sample ${i})`).toBe('');
        await page.waitForTimeout(200);
      }

      release();
      const res = await posted;
      expect(res.status(), 'remind POST').toBe(200);
      expect(((await res.json()) as { data?: { delivered?: boolean } }).data?.delivered, 'the reminder is logged, not emailed').toBe(false);
      // Only now — the server has answered — the toast says so, and says exactly the true thing in the page's locale
      // (not "sent": an equality on the real localized string, which holds in French and Chinese too).
      await expect(toast).toHaveText(logged);
      await expect(button).toHaveText(t('mobile.home.action.logged'));

      // A second tap on the settled button does nothing (force: Playwright will not click an aria-disabled control).
      await button.click({ force: true });
      await page.waitForTimeout(500);
      expect(posts, 'one tap = one POST').toHaveLength(1);
    });
  });

  test('maya offline: keeps the last numbers and says how old they are', async ({ page, context }) => {
    await loginAs(page, 'maya');
    const { t, formatLocale } = await openHome(page);
    const region = page.getByRole('region', { name: t('mobile.home.kpi.region') });
    await expect(region).toBeVisible();
    const before = await region.innerText();
    const bannerBefore = await page.locator('main').getByTestId('alert-carousel').count();
    await expect(page.getByTestId('stale-notice')).toHaveCount(0);

    try {
      await context.setOffline(true);
      // The Refresh button re-requests; with no network that fails and the screen must keep what it had.
      await page.getByRole('button', { name: t('mobile.home.refresh'), exact: true }).click();
      const notice = page.getByTestId('stale-notice');
      await expect(notice).toBeVisible();
      // "as of" = when that copy was saved (the snapshot's timestamp), in the app's own words and clock format.
      const savedAt = await page.evaluate((key) => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { savedAt?: string } | null)?.savedAt ?? null, HOME_SNAPSHOT_STORAGE_KEY);
      expect(savedAt, 'the stored Home snapshot').not.toBeNull();
      await expect(notice).toContainText(t('mobile.kit.offline_as_of', { time: clockTime(savedAt!, formatLocale) }));
      // The previous data is intact: not a blank, not an error card, not zeros.
      await expect(page.getByTestId('home-error')).toHaveCount(0);
      await expect(region).toBeVisible();
      expect(await region.innerText()).toBe(before);
      expect(await page.locator('main').getByTestId('alert-carousel').count()).toBe(bannerBefore);
    } finally {
      await context.setOffline(false);
    }

    // Back online the browser's 'online' event refetches by itself; if it has not cleared yet, Refresh does.
    await expect(async () => {
      if ((await page.getByTestId('stale-notice').count()) > 0) {
        await page.getByRole('button', { name: t('mobile.home.refresh'), exact: true }).click({ timeout: 2_000 }).catch(() => {});
      }
      await expect(page.getByTestId('stale-notice')).toHaveCount(0, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(region).toBeVisible();
    await expect(page.getByTestId('home-error')).toHaveCount(0);
  });

  test('fresh account: the welcome with its three next steps (not a blank), no KPIs; banner and dot exactly when the response has alerts', async ({ page }) => {
    await loginAs(page, 'fresh');
    const { t, home, fmt } = await openHome(page);
    expect(home.isBrandNew).toBe(true);
    // openHome returned after the app stored THIS response and two frames passed, so the absences below
    // are observations of an updated tab bar, not of one that had not rendered yet.
    await expect(page.getByRole('heading', { name: t('mobile.home.new.title') })).toBeVisible();
    await expect(page.locator('main')).toContainText(t('mobile.home.new.body'));
    for (const [href, key] of [
      ['/app/capture', 'mobile.home.new.snap_title'],
      ['/app/chat', 'mobile.home.new.chat_title'],
      ['/app/docs', 'mobile.home.new.docs_title'],
    ] as const) {
      const card = page.locator(`main a[data-action-card="${href}"]`);
      await expect(card).toContainText(t(key));
      await expect(card).toHaveAttribute('href', href);
    }
    await expect(page.getByRole('region', { name: t('mobile.home.kpi.region') })).toHaveCount(0);
    await expect(page.getByTestId('home-error')).toHaveCount(0);
    await expect(tabNav(page, t).locator('a[data-tab]')).toHaveCount(4);
    // A brand-new account can still have alerts (a tax date near a quarterly deadline, an
    // overdue bill). The banner shows exactly when the consumed response has alerts, and
    // the red Home dot exactly when one of them is critical — so a dot always has its
    // reason on screen. Computed from the response, never from the calendar.
    const banner = page.getByTestId('alert-carousel');
    if (home.alerts.length > 0) {
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(alertCopy(home.alerts[0], t, fmt).title);
    } else {
      await expect(banner).toHaveCount(0);
    }
    const critical = BADGES_ENABLED.home && home.alerts.some((a) => a.severity === 'critical');
    test.info().annotations.push({
      type: 'fresh-alerts',
      description: `${home.alerts.length} alert(s): ${home.alerts.map((a) => `${a.kind}/${a.severity}`).join(', ') || 'none'}`,
    });
    await expect(page.locator('a[data-tab="/app"] [data-badge="home-dot"]')).toHaveCount(critical ? 1 : 0);
    // Docs stays gated until PR 4.
    if (!BADGES_ENABLED.docs) await expect(page.locator('[data-badge="docs-count"]')).toHaveCount(0);
    await page.locator('main a[data-action-card="/app/chat"]').click();
    await page.waitForURL((u) => u.pathname === '/app/chat');
    await expectScreen(page, '/app/chat', t);
  });

  test('Home with iPhone safe-area insets (59px top / 34px bottom): the last section clears the tab bar and the page does not scroll', async ({ page, context }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    // Before the first navigation, or the first layout runs with zero insets and measures the wrong thing.
    const emulated = await applySafeAreaInsets(context, page);
    test.skip(!emulated, 'this browser cannot emulate safe-area insets (Chromium CDP Emulation.setSafeAreaInsetsOverride)');
    await loginAs(page, 'maya'); // the persona with the most on Home (banner + KPIs + three lists)
    const { t } = await openHome(page);
    await expect(page.getByRole('region', { name: t('mobile.home.kpi.region') })).toBeVisible();

    const g = await measureShell(page);
    expect(g.headerPaddingTop, 'header honours the top inset').toBe(`${IPHONE_INSETS.top}px`);
    expect(g.navPaddingBottom, 'tab bar honours the bottom inset').toBe(`${IPHONE_INSETS.bottom}px`);
    expect(g.docOverflow, 'the document itself must not scroll').toBeLessThanOrEqual(0);
    expect(g.lastContentBottom, 'Home laid out content').not.toBeNull();
    expect(g.lastContentBottom!, `content clears the tab bar (nav top ${g.navTop})`).toBeLessThanOrEqual(g.navTop);

    // main is scrolled to its end by measureShell: the final quick action is fully above the tab bar.
    const last = await page.locator('main a[data-quick]').last().boundingBox();
    expect(last, 'last quick action').not.toBeNull();
    expect(last!.y + last!.height, 'last quick action clears the tab bar').toBeLessThanOrEqual(g.navTop);

    // Touch targets on Home: KPI tiles and quick actions are ≥44×44.
    for (const sel of ['main [data-kpi]', 'main a[data-quick]']) {
      for (const box of await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { width: number; height: number }))) {
        expect(box.width, `${sel} width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${sel} height`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  // The per-persona journeys skip cleanly when a persona lacks an alert kind (alerts are live data). This
  // test is the collective gate: across maya/alex/sydney the two branches those journeys exist to exercise
  // must each have been available, or the run FAILS naming the missing branch — the seeds create overdue
  // invoices and open work, so a missing one is a data/seed regression, not a reason to go green having
  // verified nothing. (It sits last in the file; workers: 1 runs files' tests in order, but it does not
  // depend on the others — it reads each persona's /mobile/home itself.)
  test('collective gate: the persona matrix has an overdue-invoice Remind alert and a target-link alert to exercise', async ({ page }) => {
    const per: string[] = [];
    let remind = 0;
    let link = 0;
    let chatLink = 0;
    for (const persona of ['maya', 'alex', 'sydney'] as const) {
      await page.context().clearCookies();
      await loginAs(page, persona);
      const { home } = await openHome(page);
      const shown = home.alerts.slice(0, MAX_ALERTS); // only these render, so only these can be exercised
      per.push(`${persona}: ${describeKinds(shown)}`);
      remind += shown.filter((a) => a.kind === 'invoice_overdue' && a.action).length;
      link += shown.filter((a) => !a.action && a.target && /^\/app(\/|$)/.test(a.target.route)).length;
      chatLink += shown.filter((a) => !a.action && a.target?.route === '/app/chat').length;
    }
    test.info().annotations.push(
      { type: 'alert-kinds-per-persona', description: per.join(' | ') },
      { type: 'remind-alerts', description: String(remind) },
      { type: 'link-alerts', description: `${link} (of which chat: ${chatLink}${chatLink === 0 ? ' — the chat no-auto-send branch was NOT exercised' : ''})` },
    );
    const missing: string[] = [];
    if (remind === 0) missing.push('no persona has an invoice_overdue alert WITH an action: the Remind journey (optimistic state, held POST, toast after the answer) was never exercised');
    if (link === 0) missing.push('no persona has an alert with a mobile target link: the banner-link landing / chat-no-auto-send journey was never exercised');
    expect(missing, `uncovered branches (${per.join(' | ')})`).toEqual([]);
  });
});
