import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, within, cleanup } from '@testing-library/react';
import { renderWithI18n, expectTouchTarget, routeFetch, jsonResponse } from './test-utils';
import { homeFixture } from './fixtures';
import { SNAPSHOT_PREFIX, SNAPSHOT_CLEARED_EVENT, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { writeSnapshot, readSnapshot, SNAPSHOT_EVENT } from '@/app/app/_lib/useMobileData';
import type { MobileHome } from '@/lib/mobile/types';

const nav = vi.hoisted(() => ({ pathname: '/app' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
// next/link is replaced by a recorder so the test can prove every tab goes
// through it (client-side navigation, no full reload) rather than a bare <a>.
const linkCalls = vi.hoisted(() => ({ hrefs: [] as string[] }));
vi.mock('next/link', async () => {
  const React = await import('react');
  const Link = React.forwardRef<HTMLAnchorElement, { href: unknown; children?: React.ReactNode } & Record<string, unknown>>(
    ({ href, children, ...rest }, ref) => {
      linkCalls.hrefs.push(String(href));
      return React.createElement('a', { ...rest, ref, href: String(href), 'data-next-link': '' }, children);
    },
  );
  return { default: Link };
});
const replay = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@/lib/offline-queue', () => ({ initOfflineQueueReplay: replay.init }));
vi.mock('@/components/layout/language-switcher', () => ({ LanguageSwitcher: () => <div data-testid="language-switcher" /> }));

import { MobileShell, MAIN_STYLE, SHELL_STYLE, TAB_BAR_CLEARANCE } from '@/app/app/_shell/MobileShell';
import { isTabActive, TAB_CSS } from '@/app/app/_shell/TabBar';
import { badgesFrom, BADGE_MAX_AGE_MS, isBadgeSnapshotStale } from '@/app/app/_lib/useShellBadges';
import MobileChat from '@/app/app/chat/page';

const HOME_URL = '/api/v1/agentbook-core/mobile/home';
const realFetch = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  nav.pathname = '/app';
  replay.init.mockClear();
  linkCalls.hrefs.length = 0;
});

afterEach(async () => {
  cleanup();
  for (const respond of openHomeRequests.splice(0)) respond(jsonResponse(503, { success: false, error: 'test_over' }));
  await new Promise((r) => setTimeout(r, 0));
  vi.restoreAllMocks();
  global.fetch = realFetch;
});

function homeCalls(mock: ReturnType<typeof routeFetch>): number {
  return mock.mock.calls.filter((c) => String(c[0]) === HOME_URL).length;
}

function storedHome(): MobileHome | null {
  return readSnapshot<MobileHome>('home')?.data ?? null;
}

/**
 * Every deferred home request ever opened. getHome() dedupes through a
 * module-level in-flight promise, so one left open would be handed to the
 * NEXT test's shell instead of its own fetch: afterEach answers them all.
 */
const openHomeRequests: Array<(r: Response) => void> = [];

/** Home requests that stay open until the test answers them, in call order. */
function deferredHome() {
  const pending: Array<(r: Response) => void> = [];
  const mock = routeFetch({
    [HOME_URL]: () => new Promise<Response>((res) => { pending.push(res); openHomeRequests.push(res); }),
  });
  return { mock, pending };
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function answer(respond: (r: Response) => void, data: MobileHome) {
  await act(async () => {
    respond(jsonResponse(200, { success: true, data }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

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
    // Every tab was rendered by next/link, in tab order — not a bare <a>.
    expect(tabs().every((a) => a.hasAttribute('data-next-link'))).toBe(true);
    expect(linkCalls.hrefs.slice(0, 4)).toEqual(['/app', '/app/docs', '/app/capture', '/app/chat']);
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

  it('a home response that lands AFTER a clear is discarded, then asked for ONCE more under the current session', async () => {
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => clearMobileSnapshots());
    await answer(pending[0], homeFixture()); // the previous user's figures
    // Never written back, never shown.
    expect(storedHome()).toBeNull();
    expect(document.querySelector('[data-badge]')).toBeNull();
    // One retry, for whoever is signed in now.
    await waitFor(() => expect(pending).toHaveLength(2));
    await answer(pending[1], homeFixture({ alerts: [] }));
    await waitFor(() => expect(storedHome()?.alerts).toEqual([]));
    expect(homeCalls(mock)).toBe(2);
  });

  it('the retry happens at most once', async () => {
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => clearMobileSnapshots());
    await answer(pending[0], homeFixture());
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => clearMobileSnapshots());
    await answer(pending[1], homeFixture());
    await settle();
    expect(homeCalls(mock)).toBe(2);
    expect(storedHome()).toBeNull();
  });

  it('no retry when the clear came from a 401', async () => {
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => clearMobileSnapshots('unauthorized'));
    await answer(pending[0], homeFixture());
    await settle();
    expect(homeCalls(mock)).toBe(1);
    expect(storedHome()).toBeNull();
    expect(document.querySelector('[data-badge]')).toBeNull();
  });

  it('a 401 on its own fetch is never retried', async () => {
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(401, { success: false, error: 'unauthorized' }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(homeCalls(fetchMock)).toBe(1));
    await settle();
    expect(homeCalls(fetchMock)).toBe(1);
  });

  it('another tab removing the home snapshot mid-request: the old response is not written back', async () => {
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: `${SNAPSHOT_PREFIX}home`, newValue: null }));
    });
    await answer(pending[0], homeFixture());
    expect(storedHome()).toBeNull();
    expect(document.querySelector('[data-badge]')).toBeNull();
    await waitFor(() => expect(pending).toHaveLength(2));
    await answer(pending[1], homeFixture({ alerts: [] }));
    await waitFor(() => expect(storedHome()?.alerts).toEqual([]));
    expect(homeCalls(mock)).toBe(2);
  });

  it('another tab WRITING a fresh home snapshot does not discard the request in flight', async () => {
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: `${SNAPSHOT_PREFIX}home`, newValue: '{}' }));
    });
    await answer(pending[0], homeFixture());
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    expect(homeCalls(mock)).toBe(1);
  });
});

// Badges must not freeze: until PR 3 nothing else writes the home snapshot.
describe('MobileShell badges stay current (stale-while-revalidate)', () => {
  const OLD = () => new Date(Date.now() - BADGE_MAX_AGE_MS - 60_000).toISOString();

  function setVisibility(state: DocumentVisibilityState) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  }

  it('a stale snapshot is shown at once AND revalidated with exactly one request', async () => {
    writeSnapshot('home', homeFixture(), OLD());
    const { mock, pending } = deferredHome();
    renderWithI18n(<MobileShell><p /></MobileShell>);
    // Shown immediately, before the request answers.
    expect(await screen.findByRole('link', { name: 'Docs, 3 items need review' })).toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(1));
    // The user reviewed everything and paid the invoice: the badges go.
    await answer(pending[0], homeFixture({ alerts: [] }));
    await waitFor(() => expect(document.querySelector('[data-badge]')).toBeNull());
    expect(homeCalls(mock)).toBe(1);
  });

  it('a fresh snapshot makes no request', async () => {
    writeSnapshot('home', homeFixture());
    const fetchMock = routeFetch({});
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });
    await settle();
    expect(homeCalls(fetchMock)).toBe(0);
  });

  it('a failed revalidation keeps the old snapshot and its badges', async () => {
    writeSnapshot('home', homeFixture(), OLD());
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(500, { success: false, error: 'boom' }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await waitFor(() => expect(homeCalls(fetchMock)).toBe(1));
    await settle();
    expect(screen.getByRole('link', { name: 'Docs, 3 items need review' })).toBeInTheDocument();
    expect(storedHome()).not.toBeNull();
  });

  it('becoming visible revalidates ONLY when the snapshot has gone stale', async () => {
    writeSnapshot('home', homeFixture());
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    await screen.findByRole('link', { name: 'Docs, 3 items need review' });

    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(homeCalls(fetchMock)).toBe(0); // still fresh

    // Time passes (the stored copy ages without any event).
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, JSON.stringify({ data: homeFixture(), savedAt: OLD() }));
    setVisibility('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(homeCalls(fetchMock)).toBe(0); // hidden: nothing

    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(homeCalls(fetchMock)).toBe(1));
    await waitFor(() => expect(document.querySelector('[data-badge]')).toBeNull());
  });

  it('removes every listener it added on unmount, and an unmounted shell never fetches', async () => {
    const wAdd = vi.spyOn(window, 'addEventListener');
    const wRemove = vi.spyOn(window, 'removeEventListener');
    const dAdd = vi.spyOn(document, 'addEventListener');
    const dRemove = vi.spyOn(document, 'removeEventListener');
    writeSnapshot('home', homeFixture());
    const fetchMock = routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    const { unmount } = renderWithI18n(<MobileShell><p /></MobileShell>);
    unmount();
    const count = (spy: typeof wAdd | typeof dAdd, type: string) => spy.mock.calls.filter((c) => c[0] === type).length;
    for (const type of [SNAPSHOT_EVENT, SNAPSHOT_CLEARED_EVENT, 'storage']) {
      expect(count(wAdd, type), type).toBeGreaterThan(0);
      expect(count(wRemove, type), type).toBe(count(wAdd, type));
    }
    expect(count(dAdd, 'visibilitychange')).toBeGreaterThan(0);
    expect(count(dRemove, 'visibilitychange')).toBe(count(dAdd, 'visibilitychange'));

    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, JSON.stringify({ data: homeFixture(), savedAt: OLD() }));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(homeCalls(fetchMock)).toBe(0);
  });

  it('isBadgeSnapshotStale: missing, old, and future-dated are stale; recent is not', () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    expect(isBadgeSnapshotStale(null, now)).toBe(true);
    expect(isBadgeSnapshotStale({ data: {}, savedAt: new Date(now - 30_000).toISOString() }, now)).toBe(false);
    expect(isBadgeSnapshotStale({ data: {}, savedAt: new Date(now - BADGE_MAX_AGE_MS - 1).toISOString() }, now)).toBe(true);
    expect(isBadgeSnapshotStale({ data: {}, savedAt: new Date(now + 60_000).toISOString() }, now)).toBe(true);
  });
});

describe('Docs badge text', () => {
  it('caps the visible count at 99+ but says the real number to assistive tech', async () => {
    routeFetch({});
    writeSnapshot('home', homeFixture({ alerts: [{ id: 'r', kind: 'review_needed', severity: 'warn', params: { count: 150 } }] }));
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const docs = await screen.findByRole('link', { name: 'Docs, 150 items need review' });
    expect(within(docs).getByText('99+')).toBeInTheDocument();
  });

  it('uses the singular form for one item', async () => {
    routeFetch({});
    writeSnapshot('home', homeFixture({ alerts: [{ id: 'r', kind: 'review_needed', severity: 'warn', params: { count: 1 } }] }));
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const docs = await screen.findByRole('link', { name: 'Docs, 1 item needs review' });
    expect(within(docs).getByText('1')).toBeInTheDocument();
    // No critical alert in this snapshot: Home has no dot and its plain name.
    expect(screen.getByRole('link', { name: 'Home' }).querySelector('[data-badge]')).toBeNull();
  });
});

describe('Capture button states', () => {
  it('draws the keyboard focus ring ON the circle, in token colours', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const capture = tabs().find((a) => a.getAttribute('href') === '/app/capture')!;
    const circle = capture.querySelector('.ab-tab-circle') as HTMLElement;
    expect(capture.classList.contains('ab-tab-raised')).toBe(true);
    expect(circle).not.toBeNull();
    const css = document.querySelector('nav style')?.textContent ?? '';
    expect(css).toBe(TAB_CSS);
    expect(css).toContain('.ab-tab-raised:focus-visible{outline:none}');
    expect(css).toContain('.ab-tab-raised:focus-visible .ab-tab-circle{outline:3px solid hsl(var(--foreground))');
    // Every tab gets a visible focus outline, not only Capture.
    expect(tabs().every((a) => a.classList.contains('ab-tab'))).toBe(true);
    expect(css).toMatch(/\.ab-tab:focus-visible\{outline:2px solid hsl\(var\(--foreground\)\)/);
  });

  it('shows the active state as a ring around the circle, not only bolder text', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    nav.pathname = '/app/capture';
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const capture = tabs().find((a) => a.getAttribute('href') === '/app/capture')!;
    const circle = capture.querySelector('.ab-tab-circle') as HTMLElement;
    expect(capture.getAttribute('aria-current')).toBe('page');
    expect(circle.getAttribute('data-active')).toBe('true');
    expect(TAB_CSS).toContain('.ab-tab-raised[aria-current="page"] .ab-tab-circle{box-shadow:0 0 0 3px hsl(var(--card)),0 0 0 6px hsl(var(--primary))');
    // An inline box-shadow would beat the class rule and hide the ring.
    expect(circle.style.boxShadow).toBe('');
  });

  it('the state CSS uses token colours only', () => {
    expect(TAB_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const rest = TAB_CSS.replace(/hsl\(var\(--[a-z-]+\)(?: \/ [\d.]+)?\)/g, '');
    expect(rest).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
  });
});

// The shell is a bounded column so a screen can size itself to what is left
// between the header and the tab bar, whatever the safe-area insets are.
describe('Shell layout', () => {
  it('is exactly one viewport tall, with <main> as the only scroller', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><p /></MobileShell>);
    const shell = document.querySelector('[data-mobile-shell]') as HTMLElement;
    expect(shell.style.height).toBe('100dvh');
    expect(shell.style.overflow).toBe('hidden');
    expect(shell.style.flexDirection).toBe('column');
    const main = document.getElementById('mobile-main') as HTMLElement;
    expect(main.style.minHeight).toMatch(/^0(px)?$/);
    expect(main.style.overflowY).toBe('auto');
    expect(SHELL_STYLE).toMatchObject({ height: '100dvh', minHeight: 0, overflow: 'hidden' });
    expect(MAIN_STYLE).toMatchObject({ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', paddingBottom: TAB_BAR_CLEARANCE });
    // Tab bar height + the raised button's overhang + the bottom inset.
    expect(TAB_BAR_CLEARANCE).toBe('calc(88px + env(safe-area-inset-bottom))');
  });

  it('the legacy chat screen fills the space the shell gives it instead of assuming calc(100dvh - 64px)', () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture({ alerts: [] }) }) });
    renderWithI18n(<MobileShell><MobileChat /></MobileShell>);
    const main = document.getElementById('mobile-main') as HTMLElement;
    const root = main.firstElementChild as HTMLElement;
    expect(root.style.height).toBe('100%');
    expect(root.style.minHeight).toMatch(/^0(px)?$/);
    expect(root.getAttribute('style') ?? '').not.toContain('100dvh');
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
