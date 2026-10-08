import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import MobileHomePage from '@/app/app/page';
import { ToastHost } from '@/app/app/_kit/Toast';
import { writeSnapshot } from '@/app/app/_lib/useMobileData';
import { makeFormatters } from '@/app/app/_kit/format';
import { SNAPSHOT_PREFIX } from '@/lib/mobile/snapshot-keys';
import { BADGE_MAX_AGE_MS } from '@/app/app/_shell/badges';
import { renderWithI18n, routeFetch, jsonResponse, touch, expectTouchTarget } from './test-utils';
import { homeFixture } from './fixtures';

const HOME_URL = '/api/v1/agentbook-core/mobile/home';
const REMIND_URL = '/api/v1/agentbook-invoice/invoices/inv-1/remind';
const SAVED_AT = '2026-10-07T14:30:00.000Z';

function renderHome(locale = 'en') {
  return renderWithI18n(<ToastHost><MobileHomePage /></ToastHost>, locale);
}

const callsTo = (mock: ReturnType<typeof routeFetch>, url: string) => mock.mock.calls.filter((c) => String(c[0]) === url).length;
const homeCalls = (mock: ReturnType<typeof routeFetch>) => callsTo(mock, HOME_URL);

/** Let pending fetch promises and the effects they trigger run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** A /mobile/home route whose Nth answer (1-based) can be held open. */
function deferredHome() {
  const pending: Array<(r: Response) => void> = [];
  const handler = () => new Promise<Response>((r) => { pending.push(r); });
  return { handler, answer: (body = homeFixture()) => pending.shift()!(jsonResponse(200, { success: true, data: body })), pending };
}

/**
 * The error card (role="alert"). Found by test id: the ToastHost keeps its own
 * empty role="alert" live region mounted, and a critical banner is an alert too.
 */
function errorCard() {
  const el = screen.getByTestId('home-error');
  expect(el).toHaveAttribute('role', 'alert');
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Home page states', () => {
  it('shows a labelled skeleton while the first load is in flight', async () => {
    let answer!: (r: Response) => void;
    routeFetch({ [HOME_URL]: () => new Promise<Response>((r) => { answer = r; }) });
    renderHome();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    await act(async () => { answer(jsonResponse(200, { success: true, data: homeFixture() })); });
    expect(screen.queryByTestId('home-skeleton')).toBeNull();
  });

  it('offline with a snapshot: shows the cached numbers and says "as of HH:MM"', async () => {
    writeSnapshot('home', homeFixture(), SAVED_AT);
    routeFetch({ [HOME_URL]: () => new TypeError('Failed to fetch') });
    renderHome();
    const notice = await screen.findByTestId('stale-notice');
    expect(notice).toHaveTextContent(`Offline · showing data as of ${makeFormatters('en').time(SAVED_AT)}`);
    expect(screen.getByRole('region', { name: 'Key numbers' })).toHaveTextContent('CA$9,800');
    expect(screen.queryByTestId('home-error')).toBeNull();
  });

  it('server error with a snapshot: cached numbers, "couldn’t refresh" — not "offline"', async () => {
    writeSnapshot('home', homeFixture(), SAVED_AT);
    routeFetch({ [HOME_URL]: () => jsonResponse(503, { success: false, error: 'busy' }) });
    renderHome();
    const notice = await screen.findByTestId('stale-notice');
    expect(notice).toHaveTextContent(`Couldn’t refresh · showing data as of ${makeFormatters('en').time(SAVED_AT)}`);
    expect(notice).not.toHaveTextContent('Offline');
    expect(screen.getByRole('region', { name: 'Key numbers' })).toBeInTheDocument();
  });

  it('the stale notice’s Retry fetches again and clears the notice on success', async () => {
    writeSnapshot('home', homeFixture(), SAVED_AT);
    let calls = 0;
    const mock = routeFetch({
      [HOME_URL]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse(503, { success: false, error: 'busy' }) : jsonResponse(200, { success: true, data: homeFixture() });
      },
    });
    renderHome();
    const notice = await screen.findByTestId('stale-notice');
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('stale-notice')).toBeNull());
    expect(homeCalls(mock)).toBe(2);
  });

  it('a successful load writes the snapshot the shell badges read, and shows no stale notice', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    expect(screen.queryByTestId('stale-notice')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`) as string).data.currency).toBe('CAD');
  });

  it('never renders the server’s error message, only our copy', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(500, { success: false, error: 'pg: relation ab_invoice does not exist' }) });
    renderHome();
    await waitFor(() => expect(errorCard()).toHaveTextContent('Couldn’t load this'));
    expect(document.body.textContent).not.toContain('relation');
    expect(document.body.textContent).not.toContain('HTTP 500');
  });

  it('rate limited with nothing cached: says so, with Retry', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(429, { success: false, error: 'rate_limited' }) });
    renderHome();
    await waitFor(() => expect(errorCard()).toHaveTextContent('Too many requests'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a 401 shows the signed-out state with a sign-in link, and does not refetch in a loop', async () => {
    const mock = routeFetch({ [HOME_URL]: () => jsonResponse(401, { success: false, error: 'unauthorized' }) });
    renderHome();
    const link = await screen.findByRole('link', { name: 'Sign in again' });
    expect(link).toHaveAttribute('href', '/login?redirect=%2Fapp');
    expect(errorCard()).toHaveTextContent('You’ve been signed out');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    await settle();
    expect(homeCalls(mock)).toBe(1);
  });

  it('a 401 on Remind drops the old figures, reloads once, and lands signed out — no loop', async () => {
    let status = 200;
    const mock = routeFetch({
      [HOME_URL]: () => (status === 200 ? jsonResponse(200, { success: true, data: homeFixture() }) : jsonResponse(401, { success: false, error: 'unauthorized' })),
      [REMIND_URL]: () => jsonResponse(401, { success: false, error: 'unauthorized' }),
    });
    renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    status = 401;
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Key numbers' })).toBeNull();
    await settle();
    expect(homeCalls(mock)).toBe(2);
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
  });
});

describe('Home page — brand-new account with alerts', () => {
  it('shows the alert carousel ABOVE the welcome, so a red tab dot always has its reason on screen', async () => {
    const brandNewWithAlert = homeFixture({
      isBrandNew: true,
      nextUp: [],
      recent: [],
      kpis: { monthNetCents: null, cashTodayCents: null, outstandingCents: 0, overdueCount: 0, overdueCents: 0, estTaxOwedCents: 0 },
      alerts: [{ id: 'tax_deadline:q3', kind: 'tax_deadline', severity: 'critical', params: { days: 2, amountCents: 300_000 }, target: { route: '/app/chat', query: { topic: 'tax_deadline' } } }],
    });
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: brandNewWithAlert }) });
    renderHome();
    const welcome = await screen.findByText(/let’s get your books started/i);
    const carousel = screen.getByTestId('alert-carousel');
    expect(carousel).toHaveTextContent('Estimated tax payment of CA$3,000 due in 2 days');
    expect(carousel.compareDocumentPosition(welcome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Key numbers' })).toBeNull();
  });

  it('a brand-new account with NO alerts shows no carousel at all', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ isBrandNew: true, alerts: [], nextUp: [], recent: [] }) }) });
    renderHome();
    await screen.findByText(/let’s get your books started/i);
    expect(screen.queryByTestId('alert-carousel')).toBeNull();
  });
});

describe('Home page — populated', () => {
  it('renders the sections in spec order: alerts, KPIs, next up, recent, quick actions', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome();
    const kpis = await screen.findByRole('region', { name: 'Key numbers' });
    const order = [
      screen.getByTestId('alert-carousel'),
      kpis,
      screen.getByRole('heading', { name: 'Next up' }),
      screen.getByRole('heading', { name: 'Recent activity' }),
      screen.getByRole('heading', { name: 'Quick actions' }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `section ${i}`).toBeTruthy();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'AgentBook' })).toBeInTheDocument();
    expect(screen.getByText('Here’s what needs you today')).toBeInTheDocument();
  });

  it('formats money in the account’s currency (data.currency), not a default', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ currency: 'USD' }) }) });
    renderHome();
    const region = await screen.findByRole('region', { name: 'Key numbers' });
    expect(region).toHaveTextContent('$9,800');
    expect(region).not.toHaveTextContent('CA$');
  });

  it('a recent expense links to the Docs list until the viewer ships (PR 4)', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    const recent = screen.getByRole('heading', { name: 'Recent activity' }).closest('section') as HTMLElement;
    const staples = within(recent).getByText('Staples').closest('a');
    expect(staples).toHaveAttribute('href', '/app/docs');
  });

  it('pull-to-refresh fetches again and keeps the numbers on screen meanwhile', async () => {
    const mock = routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    // Touches bubble from the heading to the page root, where the pull handlers live.
    const root = screen.getByRole('heading', { level: 1, name: 'AgentBook' });
    await act(async () => {
      touch(root, 'touchstart', 100, 100);
      touch(root, 'touchmove', 100, 320);
      touch(root, 'touchend', 100, 320);
    });
    await waitFor(() => expect(homeCalls(mock)).toBe(2));
    expect(screen.getByRole('region', { name: 'Key numbers' })).toBeInTheDocument();
  });

  it('the pull indicator says "Refreshing" for the whole request, not a flicker', async () => {
    const home = deferredHome();
    routeFetch({ [HOME_URL]: home.handler });
    renderHome();
    await act(async () => { home.answer(); });
    await screen.findByRole('region', { name: 'Key numbers' });
    const root = screen.getByRole('heading', { level: 1, name: 'AgentBook' });
    await act(async () => {
      touch(root, 'touchstart', 100, 100);
      touch(root, 'touchmove', 100, 320);
      touch(root, 'touchend', 100, 320);
    });
    await settle();
    expect(home.pending).toHaveLength(1);
    expect(screen.getByTestId('pull-indicator')).toHaveTextContent('Refreshing');
    await settle();
    expect(screen.getByTestId('pull-indicator')).toHaveTextContent('Refreshing');
    await act(async () => { home.answer(); });
    await waitFor(() => expect(screen.queryByTestId('pull-indicator')).toBeNull());
  });

  it('has a Refresh button (no gesture needed): 44px, aria-busy while the request runs', async () => {
    const home = deferredHome();
    const mock = routeFetch({ [HOME_URL]: home.handler });
    renderHome();
    await act(async () => { home.answer(); });
    await screen.findByRole('region', { name: 'Key numbers' });
    const button = screen.getByRole('button', { name: 'Refresh' });
    expectTouchTarget(button);
    expect(button).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(button);
    await settle();
    expect(homeCalls(mock)).toBe(2);
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'true');
    // A second tap while busy does not start another request.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(homeCalls(mock)).toBe(2);
    await act(async () => { home.answer(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByRole('region', { name: 'Key numbers' })).toBeInTheDocument();
  });

  it('Refresh (not a pull) shows no pull-indicator row: no layout jump, no second "Refreshing" announcement', async () => {
    const home = deferredHome();
    routeFetch({ [HOME_URL]: home.handler });
    renderHome();
    await act(async () => { home.answer(); });
    await screen.findByRole('region', { name: 'Key numbers' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('pull-indicator')).toBeNull();
    await act(async () => { home.answer(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByTestId('pull-indicator')).toBeNull();
  });

  it('a Remind from the banner reloads Home after the server confirms', async () => {
    const mock = routeFetch({
      [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }),
      [REMIND_URL]: () => jsonResponse(200, { success: true, data: { tone: 'firm' } }),
    });
    renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(homeCalls(mock)).toBe(2));
    expect(screen.getByRole('status', { name: 'Notifications' })).toHaveTextContent('Reminder logged');
  });

  it('the banner and the Outstanding sheet share one action state: one POST, "Logged" in both', async () => {
    const mock = routeFetch({
      [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }),
      [REMIND_URL]: () => jsonResponse(200, { success: true, data: { tone: 'firm' } }),
    });
    renderHome();
    const region = await screen.findByRole('region', { name: 'Key numbers' });
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(homeCalls(mock)).toBe(2));
    fireEvent.click(within(region).getByRole('button', { name: /^Outstanding/ }));
    const list = await screen.findByRole('list', { name: 'Overdue invoice list' });
    const reminded = within(list).getByRole('button', { name: 'Logged' });
    expect(reminded).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(reminded);
    expect(callsTo(mock, REMIND_URL)).toBe(1);
  });

  it('the post-tap state never claims the client was contacted (en / fr-CA / zh-CN)', async () => {
    const { i18nT } = await import('./test-utils');
    expect(i18nT('en')('mobile.home.action.logged')).toBe('Logged');
    expect(i18nT('fr-CA')('mobile.home.action.logged')).toBe('Consigné');
    expect(i18nT('zh-CN')('mobile.home.action.logged')).toBe('已记录');
  });

  it('renders in Chinese with CAD figures', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome('zh-CN');
    const region = await screen.findByRole('region', { name: '关键数据' });
    expect(region).toHaveTextContent('本月净额');
    expect(screen.getByRole('heading', { name: '即将到期' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
  });
});

/**
 * A PWA resumed in place on Home must not show hours-old numbers as live: the
 * shell's dot revalidates on visibilitychange after BADGE_MAX_AGE_MS, and so
 * must the screen (one shared getHome() request when both fire).
 */
describe('Home page — revalidates when the app becomes visible again', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T14:00:00.000Z'));
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const becomeVisible = async (state: DocumentVisibilityState = 'visible') => {
    visibility = state;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
  };

  async function loaded() {
    const mock = routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    const view = renderHome();
    await screen.findByRole('region', { name: 'Key numbers' });
    expect(homeCalls(mock)).toBe(1);
    return { mock, view };
  }

  it('older than BADGE_MAX_AGE_MS → exactly one reload', async () => {
    const { mock } = await loaded();
    vi.setSystemTime(new Date(Date.now() + BADGE_MAX_AGE_MS + 1_000));
    await becomeVisible();
    expect(homeCalls(mock)).toBe(2);
    expect(screen.getByRole('region', { name: 'Key numbers' })).toBeInTheDocument();
    // The reload just landed, so the next resume is fresh again.
    await becomeVisible();
    expect(homeCalls(mock)).toBe(2);
  });

  it('fresh (within BADGE_MAX_AGE_MS) → no reload', async () => {
    const { mock } = await loaded();
    vi.setSystemTime(new Date(Date.now() + BADGE_MAX_AGE_MS - 1_000));
    await becomeVisible();
    expect(homeCalls(mock)).toBe(1);
  });

  it('becoming hidden → no reload, however old', async () => {
    const { mock } = await loaded();
    vi.setSystemTime(new Date(Date.now() + BADGE_MAX_AGE_MS * 10));
    await becomeVisible('hidden');
    expect(homeCalls(mock)).toBe(1);
  });

  it('the listener is removed on unmount', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { mock, view } = await loaded();
    view.unmount();
    expect(remove.mock.calls.map((c) => c[0])).toContain('visibilitychange');
    vi.setSystemTime(new Date(Date.now() + BADGE_MAX_AGE_MS * 10));
    await becomeVisible();
    expect(homeCalls(mock)).toBe(1);
  });

  it('the signed-out state does not refetch on every resume', async () => {
    const mock = routeFetch({ [HOME_URL]: () => jsonResponse(401, { success: false, error: 'unauthorized' }) });
    renderHome();
    await screen.findByRole('link', { name: 'Sign in again' });
    vi.setSystemTime(new Date(Date.now() + BADGE_MAX_AGE_MS * 10));
    await becomeVisible();
    expect(homeCalls(mock)).toBe(1);
  });
});
