import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import { renderWithI18n, expectTouchTarget, routeFetch, jsonResponse } from './test-utils';
import { homeFixture } from './fixtures';
import { SNAPSHOT_PREFIX, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { writeSnapshot } from '@/app/app/_lib/useMobileData';

const nav = vi.hoisted(() => ({ pathname: '/app' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
const replay = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@/lib/offline-queue', () => ({ initOfflineQueueReplay: replay.init }));
vi.mock('@/components/layout/language-switcher', () => ({ LanguageSwitcher: () => <div data-testid="language-switcher" /> }));

import { MobileShell } from '@/app/app/_shell/MobileShell';
import { isTabActive } from '@/app/app/_shell/TabBar';
import { badgesFrom } from '@/app/app/_lib/useShellBadges';

const HOME_URL = '/api/v1/agentbook-core/mobile/home';
const realFetch = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  nav.pathname = '/app';
  replay.init.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = realFetch;
});

function tabs() {
  const navEl = screen.getByRole('navigation', { name: 'Main navigation' });
  return Array.from(navEl.querySelectorAll('a[data-tab]')) as HTMLAnchorElement[];
}

describe('MobileShell', () => {
  it('renders four tabs in the order Home · Docs · Capture · Chat, as client-side links', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p>child</p></MobileShell>);
    expect(tabs().map((a) => a.getAttribute('href'))).toEqual(['/app', '/app/docs', '/app/capture', '/app/chat']);
    expect(tabs().map((a) => a.textContent)).toEqual(['Home', 'Docs', 'Capture', 'Chat']);
    expect(screen.getByText('child')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it('labels come from the catalog (zh-CN)', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>, 'zh-CN');
    const navEl = screen.getByRole('navigation', { name: '主导航' });
    expect(Array.from(navEl.querySelectorAll('a[data-tab]')).map((a) => a.textContent)).toEqual(['首页', '单据', '记账', '对话']);
  });

  it('every tab is at least 44×44', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    for (const a of tabs()) expectTouchTarget(a);
  });

  it('marks exactly the active tab with aria-current="page", including nested routes', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    nav.pathname = '/app/docs/exp-1';
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const current = tabs().filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/app/docs']);
  });

  it('isTabActive: Home only on /app itself; others on their subtree but not on look-alike prefixes', () => {
    expect(isTabActive('/app', '/app')).toBe(true);
    expect(isTabActive('/app', '/app/docs')).toBe(false);
    expect(isTabActive('/app/docs', '/app/docs')).toBe(true);
    expect(isTabActive('/app/docs', '/app/docs/abc')).toBe(true);
    expect(isTabActive('/app/docs', '/app/docsx')).toBe(false);
    expect(isTabActive('/app/chat', null)).toBe(false);
  });

  it('badges come from the cached home snapshot with NO network request', async () => {
    const fetchMock = routeFetch({});
    writeSnapshot('home', homeFixture());
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const docs = await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    expect(within(docs).getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home, needs attention' }).querySelector('[data-badge="home-dot"]')).not.toBeNull();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === HOME_URL)).toHaveLength(0);
  });

  it('without a snapshot it fetches home ONCE, stores the snapshot, and shows the badges', async () => {
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === HOME_URL)).toHaveLength(1);
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).not.toBeNull();
  });

  it('offline with no snapshot: no request, no badges', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchMock = routeFetch({});
    renderWithI18n(<MobileShell><p /></MobileShell>);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === HOME_URL)).toHaveLength(0);
    expect(document.querySelector('[data-badge]')).toBeNull();
  });

  it('badges follow a fresh snapshot written by the Home screen', async () => {
    writeSnapshot('home', homeFixture({ alerts: [] }));
    routeFetch({});
    renderWithI18n(<MobileShell><p /></MobileShell>);
    expect(document.querySelector('[data-badge]')).toBeNull();
    act(() => writeSnapshot('home', homeFixture()));
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
  });

  it('keeps the language switcher and starts the offline-queue replay once', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    expect(screen.getByTestId('language-switcher')).toBeInTheDocument();
    expect(replay.init).toHaveBeenCalledTimes(1);
  });

  it('provides a toast host to every screen', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    expect(screen.getByRole('status', { name: 'Notifications' })).toBeInTheDocument();
  });
});

// The badges show the signed-in user's figures. Once the session is gone they
// must go too, by every route the snapshots can be cleared.
describe('MobileShell badges after sign-out / an invalid session', () => {
  it('disappear when the snapshots are cleared (sign-out, another user signing in)', async () => {
    routeFetch({});
    writeSnapshot('home', homeFixture());
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    act(() => clearMobileSnapshots());
    await waitFor(() => expect(document.querySelector('[data-badge]')).toBeNull());
    expect(screen.queryByRole('link', { name: 'Docs, 3 items need review' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Home, needs attention' })).toBeNull();
  });

  it('disappear when another tab removes the home snapshot (cross-tab storage event)', async () => {
    routeFetch({});
    writeSnapshot('home', homeFixture());
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    window.localStorage.removeItem(`${SNAPSHOT_PREFIX}home`);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: `${SNAPSHOT_PREFIX}home`, newValue: null }));
    });
    await waitFor(() => expect(document.querySelector('[data-badge]')).toBeNull());
  });

  it('disappear when another tab calls localStorage.clear() (storage event with key null)', async () => {
    routeFetch({});
    writeSnapshot('home', homeFixture());
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    await waitFor(() => expect(document.querySelector('[data-badge]')).toBeNull());
  });

  it('a 401 from its own home fetch shows no badges and clears every stored snapshot', async () => {
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}docs:needs-review`, JSON.stringify({ data: [1], savedAt: '2026-10-07T00:00:00.000Z' }));
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(401, { success: false, error: 'unauthorized' }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]) === HOME_URL)).toHaveLength(1));
    await waitFor(() => expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:needs-review`)).toBeNull());
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    expect(document.querySelector('[data-badge]')).toBeNull();
  });

  it('a home response that lands AFTER a clear is not stored or shown (sign-out mid-request)', async () => {
    let answer!: (r: Response) => void;
    routeFetch({ [HOME_URL]: () => new Promise<Response>((res) => { answer = res; }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    act(() => clearMobileSnapshots());
    await act(async () => {
      answer(jsonResponse(200, { success: true, data: homeFixture() }));
      await Promise.resolve();
    });
    // Give the getHome() chain time to settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    expect(document.querySelector('[data-badge]')).toBeNull();
  });
});

describe('badgesFrom', () => {
  it('derives the dot and the count, and ignores junk', () => {
    expect(badgesFrom(homeFixture())).toEqual({ homeCritical: true, docsNeedsReview: 3 });
    expect(badgesFrom(homeFixture({ alerts: [] }))).toEqual({ homeCritical: false, docsNeedsReview: 0 });
    expect(badgesFrom(null)).toEqual({ homeCritical: false, docsNeedsReview: 0 });
    expect(
      badgesFrom(homeFixture({ alerts: [{ id: 'x', kind: 'review_needed', severity: 'info', params: { count: 'many' } }] })),
    ).toEqual({ homeCritical: false, docsNeedsReview: 0 });
  });
});
