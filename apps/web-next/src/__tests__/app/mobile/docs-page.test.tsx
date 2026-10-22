/**
 * The Docs list page over a mocked global fetch: the real listDocs / api-extra
 * run, so the query parameters the phone sends (filter → params, search, cursor,
 * withCounts) are asserted, and failures come from real HTTP answers rather than
 * from a mocked module.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { moneyText, ToastHost } from '@/app/app/_kit';
import { MockIntersectionObserver } from './_mock-io';
import { expectTouchTarget, jsonResponse, routeFetch } from './test-utils';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/app/docs',
  useParams: () => ({}),
}));

import MobileDocsPage from '@/app/app/docs/page';
import './_load-tolerance';

const EXPENSES = '/api/v1/agentbook-expense/expenses';
const TENANT = '/api/v1/agentbook-core/tenant-config';
const PENDING = '/api/v1/agentbook-core/auto-categorize/pending';
const REVIEW = '/api/v1/agentbook-core/auto-categorize/review';
const ok = (data: unknown, meta?: unknown) => jsonResponse(200, { success: true, data, ...(meta ? { meta } : null) });

type Raw = Record<string, unknown>;
const raw = (o: Raw = {}): Raw => ({
  id: 'e1', date: '2026-10-01', amountCents: 4700, vendorName: 'Blue Bottle', description: null,
  categoryId: 'c1', categoryName: 'Meals', confidence: null, status: 'confirmed', isPersonal: false,
  receiptUrl: null, receiptStatus: 'pending', archivedAt: null, journalEntryId: 'j1', ...o,
});
const COUNTS = { needsReview: 3, noCategory: 2, noReceipt: 5, archived: 1 };
const listOf = (rows: Raw[], meta: { nextCursor?: string | null; counts?: unknown; total?: number } = {}) =>
  ok(rows, { nextCursor: meta.nextCursor ?? null, counts: 'counts' in meta ? meta.counts : COUNTS, ...(meta.total !== undefined ? { total: meta.total } : null) });

type ListHandler = (qs: URLSearchParams) => Response | Error | Promise<Response>;
type RouteHandler = Parameters<typeof routeFetch>[0][string];
function mockApi(list: ListHandler, extra: Record<string, RouteHandler> = {}) {
  return routeFetch({
    [EXPENSES]: (url) => list(new URL(url, 'http://x').searchParams),
    [TENANT]: () => ok({ currency: 'CAD', jurisdiction: 'ca' }),
    [PENDING]: () => ok({ items: [], uncategorizedCount: 0 }),
    ...extra,
  });
}
/** The query string of every list request the page made, in order. */
const listCalls = (f: ReturnType<typeof routeFetch>) =>
  f.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(`${EXPENSES}?`)).map((u) => new URL(u, 'http://x').searchParams);

const renderPage = () => render(<ToastHost><MobileDocsPage /></ToastHost>);
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
const rowsOf = () => screen.findAllByTestId('doc-item');
// The page writes the URL with history.replaceState (never router.replace): these read what it wrote.
let replaceSpy: ReturnType<typeof vi.spyOn>;
const written = () => replaceSpy.mock.calls.map((c) => String(c[2]));
const urlNow = () => `${window.location.pathname}${window.location.search}`;
const results = () => screen.getByTestId('docs-results');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setOnline(true);
  nav.params = new URLSearchParams();
  nav.replace.mockReset();
  nav.push.mockReset();
  window.history.replaceState(null, '', '/app/docs');
  replaceSpy = vi.spyOn(window.history, 'replaceState');
  MockIntersectionObserver.reset();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Docs list — states', () => {
  it('shows a labelled skeleton while the first page loads', () => {
    mockApi(() => new Promise<Response>(() => {}));
    renderPage();
    const sk = screen.getByTestId('docs-skeleton');
    expect(sk).toHaveAttribute('aria-busy', 'true');
    expect(sk).toHaveAccessibleName('Loading');
  });

  it('renders rows: vendor, tenant-currency amount, date, category, AI and Review pills', async () => {
    mockApi(() => listOf([
      raw(),
      raw({ id: 'e2', vendorName: 'Staples', amountCents: 12000, categoryName: 'Office', confidence: 0.8 }),
      raw({ id: 'e3', vendorName: null, description: 'Parking', categoryId: null, categoryName: null, status: 'pending_review' }),
    ]));
    renderPage();
    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Blue Bottle')).toBeInTheDocument();
    expect(within(rows[0]).getByText(moneyText(4700, 'CAD', 'en'))).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Oct 1, 2026 · Meals/)).toBeInTheDocument();
    expect(within(rows[0]).queryByText('AI')).toBeNull();
    expect(within(rows[1]).getByText('AI')).toBeInTheDocument();
    expect(within(rows[1]).getByText(moneyText(12000, 'CAD', 'en'))).toBeInTheDocument();
    expect(within(rows[2]).getByText('Parking')).toBeInTheDocument();
    expect(within(rows[2]).getByText(/No category/)).toBeInTheDocument();
    expect(within(rows[2]).getByText('Review')).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute('href', '/app/docs/e1');
  });

  it('a row links to its viewer with the id URL-encoded', async () => {
    mockApi(() => listOf([raw({ id: 'a/b c' })]));
    renderPage();
    expect((await rowsOf())[0]).toHaveAttribute('href', '/app/docs/a%2Fb%20c');
  });

  it('shows a dash, never a guessed currency or $0.00, until the tenant currency is known', async () => {
    mockApi(() => listOf([raw()]), { [TENANT]: () => new Promise<Response>(() => {}) });
    renderPage();
    const row = (await rowsOf())[0];
    const money = row.querySelector('[data-money]')!;
    expect(money).toHaveAttribute('data-money', 'none');
    expect(row.textContent).not.toMatch(/\$|47\.00|0\.00|NaN/);
  });

  it('every row says in its own text whether it has no receipt or a PDF (the tiles are aria-hidden)', async () => {
    mockApi(() => listOf([
      raw({ id: 'none', vendorName: 'No Receipt Co', receiptUrl: null }),
      raw({ id: 'pdf', vendorName: 'Pdf Co', receiptUrl: 'https://example.com/r/invoice.pdf' }),
      raw({ id: 'img', vendorName: 'Photo Co', receiptUrl: 'https://example.com/r/photo.jpg' }),
    ]));
    renderPage();
    const [none, pdf, img] = await rowsOf();
    expect(within(none).getByText('No receipt')).toBeInTheDocument();
    expect(within(pdf).getByText('PDF receipt')).toBeInTheDocument();
    expect(within(img).queryByText(/No receipt|PDF/)).toBeNull();
  });

  it('the grid tile carries the same receipt text', async () => {
    localStorage.setItem('ab:mobile:docs:view', JSON.stringify('grid'));
    mockApi(() => listOf([raw({ id: 'none' }), raw({ id: 'pdf', receiptUrl: 'https://example.com/r/invoice.pdf' })]));
    renderPage();
    const [none, pdf] = await rowsOf();
    expect(screen.getByTestId('doc-list')).toHaveAttribute('data-view', 'grid');
    expect(within(none).getByText('No receipt')).toBeInTheDocument();
    expect(within(pdf).getByText('PDF receipt')).toBeInTheDocument();
  });

  it('shows count badges on the chips from withCounts, and asks for them', async () => {
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    expect(listCalls(f)[0].get('withCounts')).toBe('1');
    // The counts arrive a commit after the rows (they are reported up from an effect).
    expect(await screen.findByRole('button', { name: /Needs review.*3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No category.*2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No receipt.*5/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archived.*1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('shows no badges when the server sent no counts', async () => {
    mockApi(() => listOf([raw()], { counts: null }));
    renderPage();
    await rowsOf();
    expect(screen.getByRole('button', { name: 'Needs review' })).toBeInTheDocument();
  });

  it.each([
    ['needs-review', 'Nothing needs review'],
    ['no-category', 'Everything has a category'],
    ['no-receipt', 'No missing receipts'],
    ['archived', 'Nothing archived'],
    ['all', 'No documents yet'],
  ])('empty state for %s', async (filter, title) => {
    nav.params = new URLSearchParams(filter === 'all' ? '' : `filter=${filter}`);
    mockApi(() => listOf([]));
    renderPage();
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('the empty All state links to Capture; other empty states do not', async () => {
    mockApi(() => listOf([]));
    renderPage();
    expect(await screen.findByRole('link', { name: 'Snap a receipt' })).toHaveAttribute('href', '/app/capture');
  });

  it('empty search says so', async () => {
    nav.params = new URLSearchParams('q=zzz');
    mockApi(() => listOf([]));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No matches' })).toBeInTheDocument();
  });

  it('error state: Retry refetches, and focus lands on a stable element, not <body>', async () => {
    let n = 0;
    const f = mockApi(() => (++n === 1 ? jsonResponse(500, { success: false, error: 'boom' }) : listOf([raw()])));
    renderPage();
    expect(await screen.findByText("Couldn’t load your documents")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t load your documents").closest('[role="alert"]')).not.toHaveTextContent(/boom/);
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).not.toBe(document.body);
    expect(await rowsOf()).toHaveLength(1);
    expect(listCalls(f)).toHaveLength(2);
  });

  it('a signed-out session shows the sign-in state, not a retry that cannot work', async () => {
    mockApi(() => jsonResponse(401, { success: false, error: 'invalid session' }));
    renderPage();
    expect(await screen.findByRole('heading', { name: "You’ve been signed out" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/login?redirect=%2Fapp%2Fdocs');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offline with nothing saved says offline, not a server error', async () => {
    setOnline(false);
    mockApi(() => new TypeError('Failed to fetch'));
    renderPage();
    expect(await screen.findByRole('heading', { name: "You’re offline" })).toBeInTheDocument();
  });

  it('offline: serves the last good list, labelled with when it was saved', async () => {
    // The saved first page HAS a next cursor, and this browser has no IntersectionObserver (so a button would show).
    vi.stubGlobal('IntersectionObserver', undefined);
    const f = mockApi(() => listOf([raw()], { nextCursor: 'c2' }));
    const first = renderPage();
    await rowsOf();
    first.unmount();
    setOnline(false);
    f.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(EXPENSES)) throw new TypeError('Failed to fetch');
      return jsonResponse(200, { success: true, data: { currency: 'CAD' } });
    });
    renderPage();
    expect(await rowsOf()).toHaveLength(1);
    expect(screen.getByTestId('docs-offline')).toHaveTextContent(/^Offline — showing your list saved at \d/);
    // Offline means a saved first page only: no way to ask for another one.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u).includes('cursor=c2'))).toBe(false);
  });

  it('online but the refresh failed: shows the saved list as stale (not "offline") with a Retry', async () => {
    const f = mockApi(() => listOf([raw()]));
    const first = renderPage();
    await rowsOf();
    first.unmount();
    f.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(EXPENSES)) return jsonResponse(500, { success: false });
      return jsonResponse(200, { success: true, data: { currency: 'CAD' } });
    });
    renderPage();
    expect(await rowsOf()).toHaveLength(1);
    const note = await screen.findByTestId('docs-stale');
    expect(note).toHaveTextContent(/Couldn’t refresh · showing data as of/);
    expect(within(note).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('docs-offline')).toBeNull();
  });
});

describe('Docs list — filters, deep link, search, view', () => {
  it.each([
    ['needs-review', { status: 'pending_review' }, /Needs review/],
    ['no-category', { categoryId: 'none', isPersonal: 'false' }, /No category/],
    ['no-receipt', { hasReceipt: 'false', isPersonal: 'false' }, /No receipt/],
    ['archived', { archived: 'true' }, /Archived/],
  ])('deep link ?filter=%s requests exactly those params and marks the chip pressed', async (filter, params, chip) => {
    nav.params = new URLSearchParams(`filter=${filter}`);
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    const first = listCalls(f)[0];
    for (const [k, v] of Object.entries(params)) expect(first.get(k)).toBe(v);
    expect(screen.getByRole('button', { name: chip })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the first request is already the deep-linked one (no flash of the unfiltered list)', async () => {
    nav.params = new URLSearchParams('filter=needs-review');
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    expect(listCalls(f)).toHaveLength(1);
    expect(replaceSpy).not.toHaveBeenCalled(); // the URL already says so
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('falls back to All for an unknown filter and cleans the URL', async () => {
    nav.params = new URLSearchParams('filter=hacked');
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    const first = listCalls(f)[0];
    expect(first.has('status')).toBe(false);
    expect(first.has('categoryId')).toBe(false);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(null, '', '/app/docs'));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('?q= seeds the search box and the first request', async () => {
    nav.params = new URLSearchParams('q=taxi');
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    expect(listCalls(f)[0].get('q')).toBe('taxi');
    expect(screen.getByRole('searchbox', { name: 'Search documents' })).toHaveValue('taxi');
  });

  it('tapping a chip refetches with that filter and updates the URL, keeping the counts', async () => {
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await waitFor(() => expect(listCalls(f).some((p) => p.get('categoryId') === 'none')).toBe(true));
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '/app/docs?filter=no-category');
    expect(urlNow()).toBe('/app/docs?filter=no-category');
    expect(screen.getByRole('button', { name: /No category/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Needs review.*3/ })).toBeInTheDocument();
  });

  // The page remembers its own URL writes for 2 s of WALL-CLOCK time (Date.now()). Faking only Date pins that
  // clock, so a slow runner cannot age the first write past its TTL mid-test; waitFor's timers stay real.
  describe('own-write window (Date pinned)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('a rapid second tap wins, and the first one arriving in the URL does not undo it', async () => {
      mockApi(() => listOf([raw()]));
      const view = renderPage();
      await rowsOf();
      fireEvent.click(screen.getByRole('button', { name: /No category/ }));
      fireEvent.click(screen.getByRole('button', { name: /No receipt/ }));
      await waitFor(() => expect(urlNow()).toBe('/app/docs?filter=no-receipt'));
      // Next applies the first replace's params, then the second's. The first arriving must not be
      // mistaken for an outside navigation that moves the screen back to it.
      nav.params = new URLSearchParams('filter=no-category');
      view.rerender(<ToastHost><MobileDocsPage /></ToastHost>);
      expect(screen.getByRole('button', { name: /No receipt/ })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /No category/ })).toHaveAttribute('aria-pressed', 'false');
      nav.params = new URLSearchParams('filter=no-receipt');
      view.rerender(<ToastHost><MobileDocsPage /></ToastHost>);
      expect(screen.getByRole('button', { name: /No receipt/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('past the 2 s window the same URL is an outside navigation and is honoured', async () => {
      mockApi(() => listOf([raw()]));
      const view = renderPage();
      await rowsOf();
      fireEvent.click(screen.getByRole('button', { name: /No category/ }));
      fireEvent.click(screen.getByRole('button', { name: /No receipt/ }));
      await waitFor(() => expect(urlNow()).toBe('/app/docs?filter=no-receipt'));
      vi.setSystemTime(Date.now() + 2001); // the page's own writes have expired
      nav.params = new URLSearchParams('filter=no-category');
      view.rerender(<ToastHost><MobileDocsPage /></ToastHost>);
      await waitFor(() => expect(screen.getByRole('button', { name: /No category/ })).toHaveAttribute('aria-pressed', 'true'));
      expect(screen.getByRole('button', { name: /No receipt/ })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('an outside navigation (the Docs tab tapped again) resets the filter and search', async () => {
    nav.params = new URLSearchParams('filter=needs-review&q=taxi');
    const f = mockApi(() => listOf([raw()]));
    const view = renderPage();
    await rowsOf();
    nav.params = new URLSearchParams('');
    view.rerender(<ToastHost><MobileDocsPage /></ToastHost>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('searchbox', { name: 'Search documents' })).toHaveValue('');
    await waitFor(() => {
      const last = listCalls(f).at(-1)!;
      expect(last.has('status')).toBe(false);
      expect(last.has('q')).toBe(false);
    });
  });

  it('debounces search: one request, for the final text, and the URL follows', async () => {
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    const box = screen.getByRole('searchbox', { name: 'Search documents' });
    fireEvent.change(box, { target: { value: 'c' } });
    fireEvent.change(box, { target: { value: 'ca' } });
    fireEvent.change(box, { target: { value: ' cafe ' } });
    expect(listCalls(f).filter((p) => p.has('q'))).toHaveLength(0); // nothing sent while still typing
    await waitFor(() => expect(listCalls(f).some((p) => p.get('q') === 'cafe')).toBe(true));
    expect(listCalls(f).filter((p) => p.has('q')).map((p) => p.get('q'))).toEqual(['cafe']);
    await waitFor(() => expect(urlNow()).toBe('/app/docs?q=cafe'));
  });

  it('search combines with the active filter', async () => {
    nav.params = new URLSearchParams('filter=no-receipt');
    const f = mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'uber' } });
    await waitFor(() => expect(listCalls(f).some((p) => p.get('q') === 'uber' && p.get('hasReceipt') === 'false')).toBe(true));
  });

  it('grid/list toggle persists across visits', async () => {
    mockApi(() => listOf([raw()]));
    const first = renderPage();
    await rowsOf();
    expect(screen.getByTestId('doc-list')).toHaveAttribute('data-view', 'list');
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByTestId('doc-list')).toHaveAttribute('data-view', 'grid');
    expect(screen.getByRole('button', { name: 'List view' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ab:mobile:docs:view')!)).toBe('grid');
    first.unmount();
    renderPage();
    await rowsOf();
    expect(screen.getByTestId('doc-list')).toHaveAttribute('data-view', 'grid');
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(JSON.parse(localStorage.getItem('ab:mobile:docs:view')!)).toBe('list');
  });

  it('still renders and toggles when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    mockApi(() => listOf([raw()]));
    renderPage();
    expect(await rowsOf()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByTestId('doc-list')).toHaveAttribute('data-view', 'grid');
  });

  it('every control is a 44px target and the page keeps the Documents heading', async () => {
    mockApi(() => listOf([raw()]));
    renderPage();
    const rows = await rowsOf();
    expect(screen.getByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
    expectTouchTarget(screen.getByRole('button', { name: 'Grid view' }));
    expectTouchTarget(screen.getByRole('button', { name: /No category/ }));
    expect(parseFloat(rows[0].style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(screen.getByRole('searchbox').closest('label')!.style.minHeight)).toBeGreaterThanOrEqual(44);
  });
});

describe('Docs list — paging and viewer handoff', () => {
  const twoPages = (p: URLSearchParams) =>
    p.get('cursor') === 'c2'
      ? listOf([raw({ id: 'e9', vendorName: 'Page Two' })], { nextCursor: null, counts: null })
      : listOf([raw()], { nextCursor: 'c2' });

  it('loads the next cursor page when the sentinel scrolls into view, then stops at the end', async () => {
    const f = mockApi(twoPages);
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(await screen.findByText('Page Two')).toBeInTheDocument();
    expect(listCalls(f).map((p) => p.get('cursor'))).toEqual([null, 'c2']);
    expect(listCalls(f)[1].has('withCounts')).toBe(false); // counts only ride the first page
    // The last page had no cursor: the sentinel is gone and nothing more is requested.
    await waitFor(() => expect(MockIntersectionObserver.latest().observed.size).toBe(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(listCalls(f)).toHaveLength(2);
    // The counts from page one survive.
    expect(await screen.findByRole('button', { name: /Needs review.*3/ })).toBeInTheDocument();
  });

  it('the sentinel lives inside #mobile-main and observes against it', async () => {
    mockApi(twoPages);
    render(<main id="mobile-main"><ToastHost><MobileDocsPage /></ToastHost></main>);
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    expect(MockIntersectionObserver.latest().options?.root).toBe(document.getElementById('mobile-main'));
  });

  // Layout shift is impact-fraction x distance-fraction: an idle sentinel that is a 51 px padded box scored 0.06 per
  // page appended (it sits in view when rows are inserted above it), 0.12 over a Docs scroll, past the 0.1 limit.
  // Idle it must be a hairline; it only takes space while it has something to say.
  it('keeps the idle sentinel a hairline (no layout shift) and only pads it while it has content', async () => {
    let release!: (r: Response) => void;
    mockApi((p) => (p.get('cursor') === 'c2' ? new Promise<Response>((res) => { release = res; }) : listOf([raw()], { nextCursor: 'c2' })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    const sentinel = [...MockIntersectionObserver.latest().observed][0] as HTMLElement;
    expect(sentinel.style.padding).toMatch(/^0(px)?$/);
    expect(parseFloat(sentinel.style.minHeight)).toBeLessThanOrEqual(1);
    // The status line stays mounted (a live region added together with its text is often not announced).
    expect(within(sentinel).getByRole('status')).toBeInTheDocument();
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(await screen.findByText('Loading more…')).toBeInTheDocument();
    expect(parseFloat(sentinel.style.padding)).toBeGreaterThanOrEqual(16);
    await act(async () => release(listOf([raw({ id: 'e9' })], { nextCursor: null, counts: null })));
  });

  it('does not request a page when the observer fires while one is already loading', async () => {
    let release!: (r: Response) => void;
    const f = mockApi((p) => (p.get('cursor') === 'c2' ? new Promise<Response>((res) => { release = res; }) : listOf([raw()], { nextCursor: 'c2' })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    // Two deliveries before React re-renders (one act): the hook's own `loading` flag is still stale here.
    act(() => { MockIntersectionObserver.latest().fire(true); MockIntersectionObserver.latest().fire(true); });
    expect(listCalls(f).filter((p) => p.get('cursor') === 'c2')).toHaveLength(1);
    expect(screen.getByText('Loading more…').closest('[role="status"]')).not.toBeNull();
    await act(async () => release(listOf([raw({ id: 'e9' })], { nextCursor: null, counts: null })));
  });

  it('shows a Load more button when IntersectionObserver is unavailable; pressing it loads and moves focus to the first new row', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const f = mockApi(twoPages);
    renderPage();
    const button = await screen.findByRole('button', { name: 'Load more' });
    expectTouchTarget(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('Page Two')).toBeInTheDocument();
    expect(listCalls(f).map((p) => p.get('cursor'))).toEqual([null, 'c2']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Page Two').closest('a')));
  });

  it('a failed page keeps its cursor: Retry asks for the SAME cursor, and the observer does not retry on its own', async () => {
    let failing = true;
    const f = mockApi((p) => {
      if (p.get('cursor') !== 'c2') return listOf([raw()], { nextCursor: 'c2' });
      return failing ? jsonResponse(500, { success: false }) : listOf([raw({ id: 'e9', vendorName: 'Page Two' })], { nextCursor: null, counts: null });
    });
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(await screen.findByText("Couldn’t load more documents.")).toBeInTheDocument();
    const failedCalls = listCalls(f).filter((p) => p.get('cursor') === 'c2').length;
    act(() => MockIntersectionObserver.latest().fire(true)); // still in view: must not loop
    expect(listCalls(f).filter((p) => p.get('cursor') === 'c2')).toHaveLength(failedCalls);
    expect(screen.getAllByTestId('doc-item')).toHaveLength(1); // the rows already shown are kept
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Page Two')).toBeInTheDocument();
    expect(listCalls(f).filter((p) => p.get('cursor') === 'c2').length).toBe(failedCalls + 1);
    expect(screen.queryByText("Couldn’t load more documents.")).toBeNull();
  });

  it('a page that was still in flight when the list was reloaded is dropped, not appended to the new list', async () => {
    let release!: (r: Response) => void;
    let first = 0;
    mockApi((p) => {
      if (p.get('cursor') === 'c2') return new Promise<Response>((res) => { release = res; });
      return listOf([raw({ id: `fresh${++first}`, vendorName: `Fresh ${first}` })], { nextCursor: 'c2' });
    });
    renderPage();
    await screen.findByText('Fresh 1');
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true)); // page 2 is now pending
    act(() => { window.dispatchEvent(new Event('online')); }); // the list is re-read
    expect(await screen.findByText('Fresh 2')).toBeInTheDocument();
    await act(async () => release(listOf([raw({ id: 'stale', vendorName: 'Stale Row' })], { nextCursor: null, counts: null })));
    expect(screen.queryByText('Stale Row')).toBeNull();
    expect(screen.getByText('Fresh 2')).toBeInTheDocument();
  });

  it('does not list the same document twice when a page overlaps', async () => {
    mockApi((p) => (p.get('cursor') === 'c2'
      ? listOf([raw(), raw({ id: 'e9', vendorName: 'Page Two' })], { nextCursor: null, counts: null })
      : listOf([raw()], { nextCursor: 'c2' })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    await screen.findByText('Page Two');
    expect(screen.getAllByTestId('doc-item')).toHaveLength(2);
  });

  it('saves the visible ids and filter for prev/next in the viewer, including loaded pages', async () => {
    nav.params = new URLSearchParams('filter=no-receipt');
    mockApi((p) => (p.get('cursor') === 'c2'
      ? listOf([raw({ id: 'e9' })], { nextCursor: null, counts: null })
      : listOf([raw(), raw({ id: 'e2' })], { nextCursor: 'c2' })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('ab:mobile:docs:nav')!)).toEqual({ ids: ['e1', 'e2'], filter: 'no-receipt', q: '' }));
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('ab:mobile:docs:nav')!).ids).toEqual(['e1', 'e2', 'e9']));
  });
});

describe('Docs list — AI banner refresh', () => {
  const PICK = {
    expenseId: 'e2', vendorName: 'Uber', amountCents: 2300, date: '2026-10-02T00:00:00.000Z', description: null,
    suggestedCategoryId: 'c-travel', suggestedCategoryName: 'Travel', confidence: 0.7,
  };

  it('after an accepted pick the list AND the counts are re-read, and the review sheet stays open', async () => {
    let reads = 0;
    const f = mockApi(() => {
      reads += 1;
      return reads === 1
        ? listOf([raw({ id: 'e2', vendorName: 'Uber', categoryId: null, categoryName: null })], { counts: { ...COUNTS, noCategory: 2 } })
        : listOf([raw({ id: 'e2', vendorName: 'Uber', categoryName: 'Travel' }), raw({ id: 'e5', vendorName: 'Back Again' })], { counts: { ...COUNTS, noCategory: 1 } });
    }, {
      [PENDING]: () => ok({ items: [PICK], uncategorizedCount: 2 }),
      [REVIEW]: () => ok({ results: [{ expenseId: 'e2', ok: true }] }),
    });
    renderPage();
    await rowsOf();
    expect(await screen.findByRole('button', { name: /No category.*2/ })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Travel for Uber' }));
    expect(await screen.findByText('Back Again')).toBeInTheDocument();
    expect(listCalls(f)).toHaveLength(2);
    expect(listCalls(f)[1].get('withCounts')).toBe('1');
    expect(await screen.findByRole('button', { name: /No category.*1/ })).toBeInTheDocument();
    // The sheet was not torn down mid-flow: its confirmation is still announced from inside it.
    expect(screen.getByRole('dialog', { name: 'Review AI picks' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByTestId('review-status')).toHaveTextContent('1 AI pick resolved');
  });

  it('a pick dropped as no_suggestion that is still uncategorized shows up in the re-read list', async () => {
    let reads = 0;
    mockApi(() => {
      reads += 1;
      return reads === 1
        ? listOf([raw({ id: 'e1' })])
        : listOf([raw({ id: 'e1' }), raw({ id: 'e2', vendorName: 'Still Uncategorized', categoryId: null, categoryName: null })]);
    }, {
      [PENDING]: () => ok({ items: [PICK], uncategorizedCount: 1 }),
      [REVIEW]: () => ok({ results: [{ expenseId: 'e2', ok: false, error: 'no_suggestion' }] }),
    });
    renderPage();
    await rowsOf();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Accept Travel for Uber' }));
    expect(await screen.findByText('Still Uncategorized')).toBeInTheDocument();
  });

  it('Auto-categorize re-reads the list and counts too', async () => {
    let reads = 0;
    const f = mockApi(() => {
      reads += 1;
      return reads === 1
        ? listOf([raw()], { counts: { ...COUNTS, noCategory: 4 } })
        : listOf([raw()], { counts: { ...COUNTS, noCategory: 0 } });
    }, { '/api/v1/agentbook-core/auto-categorize/run': () => ok({ appliedCount: 4, pendingCount: 0, skippedCount: 0 }) });
    renderPage();
    await rowsOf();
    expect(await screen.findByRole('button', { name: /No category.*4/ })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /No category.*0/ })).toBeInTheDocument());
    expect(listCalls(f)).toHaveLength(2);
  });
});

describe('Docs list — the URL follows the screen without a router navigation', () => {
  const rerender = (view: ReturnType<typeof renderPage>) => view.rerender(<ToastHost><MobileDocsPage /></ToastHost>);

  it('chip taps and search commits never call router.replace or router.push; they write history.replaceState', async () => {
    mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: /No receipt/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'uber' } });
    await waitFor(() => expect(urlNow()).toBe('/app/docs?filter=no-receipt&q=uber'));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    expect(written()).toEqual(['/app/docs?filter=no-receipt', '/app/docs?filter=no-receipt&q=uber', '/app/docs?q=uber']);
    // The state change, not a navigation, is what refetches.
    expect(replaceSpy.mock.calls.every((c) => c[0] === null)).toBe(true);
  });

  it('A → B → A in quick succession leaves the URL equal to the screen, even when the params of B arrive late', async () => {
    mockApi(() => listOf([raw()]));
    const view = renderPage();
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(urlNow()).toBe('/app/docs');
    // Next now applies the first write's params, and then the last one's.
    nav.params = new URLSearchParams('filter=no-category');
    rerender(view);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    nav.params = new URLSearchParams('');
    rerender(view);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(urlNow()).toBe('/app/docs');
  });

  it('clearing the search box right after a commit leaves the URL without ?q=', async () => {
    mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    const box = screen.getByRole('searchbox', { name: 'Search documents' });
    fireEvent.change(box, { target: { value: 'taxi' } });
    await waitFor(() => expect(urlNow()).toBe('/app/docs?q=taxi'));
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(urlNow()).toBe('/app/docs'));
    expect(box).toHaveValue('');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a link to /app/docs?filter=x while the screen is mounted applies that filter', async () => {
    const f = mockApi(() => listOf([raw()]));
    const view = renderPage();
    await rowsOf();
    nav.params = new URLSearchParams('filter=no-receipt');
    rerender(view);
    await waitFor(() => expect(screen.getByRole('button', { name: /No receipt/ })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(listCalls(f).at(-1)!.get('hasReceipt')).toBe('false'));
    expect(written()).toEqual([]); // the URL already said so: nothing to write back
  });

  it('a stale write of ours does not swallow a later outside navigation to the same query', async () => {
    mockApi(() => listOf([raw()]));
    const view = renderPage();
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    // Our writes never showed up as params (Next coalesced them); much later a link points at the first one.
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    nav.params = new URLSearchParams('filter=no-category');
    rerender(view);
    await waitFor(() => expect(screen.getByRole('button', { name: /No category/ })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('offline, a chip tap still changes the list from the saved copy: no router navigation (the service worker cannot serve one)', async () => {
    mockApi((p) => (p.get('categoryId') === 'none'
      ? listOf([raw({ id: 'n1', vendorName: 'Uncat One', categoryId: null, categoryName: null })])
      : listOf([raw()])));
    renderPage();
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await screen.findByText('Uncat One'); // saved for next time
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByText('Blue Bottle');
    // The network goes away: every list request now fails.
    setOnline(false);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    act(() => { window.dispatchEvent(new Event('offline')); });
    nav.replace.mockClear();
    replaceSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    expect(await screen.findByText('Uncat One')).toBeInTheDocument();
    expect(screen.queryByText('Blue Bottle')).toBeNull();
    expect(screen.getByTestId('docs-offline')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    expect(written()).toEqual(['/app/docs?filter=no-category']);
  });
});

describe('Docs list — results are announced', () => {
  it('says how many documents the list has (the server total, not the rows loaded so far)', async () => {
    mockApi(() => listOf([raw()], { nextCursor: 'c2', total: 57 }));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(results()).toHaveTextContent('57 documents'));
    expect(results()).toHaveAttribute('role', 'status');
    expect(results()).toHaveAttribute('aria-live', 'polite');
  });

  it('uses the singular for one document, and falls back to the rows shown when the server sent no total', async () => {
    mockApi(() => listOf([raw()], { total: 1 }));
    const first = renderPage();
    await rowsOf();
    await waitFor(() => expect(results()).toHaveTextContent(/^1 document$/));
    first.unmount();
    sessionStorage.clear();
    localStorage.clear();
    mockApi(() => listOf([raw(), raw({ id: 'e2' })]));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(results()).toHaveTextContent(/^2 documents$/));
  });

  it('announces the new list after a filter change and after a search, from the same region (it is never remounted)', async () => {
    mockApi((p) => {
      if (p.get('q') === 'zzz') return listOf([], { total: 0 });
      if (p.get('categoryId') === 'none') return listOf([raw({ id: 'n1' }), raw({ id: 'n2' })], { total: 2 });
      return listOf([raw()], { total: 9 });
    });
    renderPage();
    await rowsOf();
    await waitFor(() => expect(results()).toHaveTextContent('9 documents'));
    const region = results();
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await waitFor(() => expect(results()).toHaveTextContent('2 documents'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), { target: { value: 'zzz' } });
    await waitFor(() => expect(results()).toHaveTextContent('No matches'));
    expect(results()).toBe(region);
  });

  it('says nothing while the next list is loading, then announces it', async () => {
    let release!: (r: Response) => void;
    mockApi((p) => (p.get('categoryId') === 'none' ? new Promise<Response>((res) => { release = res; }) : listOf([raw()], { total: 9 })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(results()).toHaveTextContent('9 documents'));
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await waitFor(() => expect(results()).toHaveTextContent(/^$/));
    await act(async () => release(listOf([raw({ id: 'n1' })], { total: 1 })));
    await waitFor(() => expect(results()).toHaveTextContent(/^1 document$/));
  });

  it('an empty result is announced as No matches', async () => {
    mockApi(() => listOf([], { total: 0 }));
    renderPage();
    await screen.findByRole('heading', { name: 'No documents yet' });
    await waitFor(() => expect(results()).toHaveTextContent('No matches'));
  });

  it('the stale notice announces its message only: the Retry button is not part of the live region', async () => {
    const f = mockApi(() => listOf([raw()]));
    const first = renderPage();
    await rowsOf();
    first.unmount();
    f.mockImplementation(async (input: RequestInfo | URL) => (String(input).startsWith(EXPENSES)
      ? jsonResponse(500, { success: false })
      : jsonResponse(200, { success: true, data: { currency: 'CAD' } })));
    renderPage();
    const note = await screen.findByTestId('docs-stale');
    const retry = within(note).getByRole('button', { name: 'Retry' });
    expect(retry.closest('[role="status"]')).toBeNull();
    expect(within(note).getByRole('status')).toHaveTextContent(/Couldn’t refresh/);
  });

  it('going offline is announced once: the list notice is the only live region, the AI banner’s copy is not', async () => {
    mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    setOnline(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    const note = await screen.findByTestId('docs-offline');
    expect(note).toHaveAttribute('role', 'status');
    // The banner states the read-only fact on screen too, but as a plain group, not a second live region.
    const banner = screen.getAllByText(/Changes are disabled until you reconnect/);
    expect(banner.length).toBeGreaterThanOrEqual(1);
    for (const n of banner) expect(n.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    // Every live region that mentions being offline: exactly one.
    const live = screen.getAllByRole('status').filter((n) => /offline|Offline/i.test(n.textContent ?? ''));
    expect(live).toHaveLength(1);
  });
});

describe('Docs list — filter switch while page 2 of the old filter is in flight', () => {
  function setup(holdNewFirst: boolean) {
    let releaseOld!: (r: Response) => void;
    let releaseNew!: () => void;
    mockApi((p) => {
      if (p.get('cursor') === 'c2') return new Promise<Response>((res) => { releaseOld = res; });
      if (p.get('categoryId') === 'none') {
        const r = listOf([raw({ id: 'n1', vendorName: 'Uncat One', categoryId: null, categoryName: null })]);
        return holdNewFirst ? new Promise<Response>((res) => { releaseNew = () => res(r); }) : r;
      }
      return listOf([raw()], { nextCursor: 'c2' });
    });
    return { relOld: (r: Response) => releaseOld(r), relNew: () => releaseNew() };
  }
  const stale = () => listOf([raw({ id: 'stale', vendorName: 'Stale Row' })], { nextCursor: 'c3', counts: null });

  it('the old page arriving AFTER the new filter rendered is dropped', async () => {
    const h = setup(false);
    renderPage();
    await screen.findByText('Blue Bottle');
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await screen.findByText('Uncat One');
    await act(async () => h.relOld(stale()));
    expect(screen.queryByText('Stale Row')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('ab:mobile:docs:nav')!).ids).toEqual(['n1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('the old page arriving BEFORE the new filter’s first page is dropped too', async () => {
    const h = setup(true);
    renderPage();
    await screen.findByText('Blue Bottle');
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    fireEvent.click(screen.getByRole('button', { name: /No category/ }));
    await act(async () => h.relOld(stale()));
    await act(async () => h.relNew());
    await screen.findByText('Uncat One');
    expect(screen.queryByText('Stale Row')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('ab:mobile:docs:nav')!).ids).toEqual(['n1']);
  });
});

describe('Docs list — limits the server enforces', () => {
  it('the search box is capped at the 100 characters the server keeps', async () => {
    mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    expect(screen.getByRole('searchbox', { name: 'Search documents' })).toHaveAttribute('maxlength', '100');
  });

  it('asks for 30 rows per page, on the first page and on the next', async () => {
    const f = mockApi((p) => (p.get('cursor') === 'c2' ? listOf([raw({ id: 'e9' })], { counts: null }) : listOf([raw()], { nextCursor: 'c2' })));
    renderPage();
    await rowsOf();
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    act(() => MockIntersectionObserver.latest().fire(true));
    await waitFor(() => expect(listCalls(f)).toHaveLength(2));
    expect(listCalls(f).map((p) => p.get('limit'))).toEqual(['30', '30']);
  });

  it('a grid tile is never narrower than the 114px it needs (96px thumbnail + padding + border), so it fits three across at 360px', async () => {
    localStorage.setItem('ab:mobile:docs:view', JSON.stringify('grid'));
    mockApi(() => listOf([raw()]));
    renderPage();
    await rowsOf();
    expect(screen.getByTestId('doc-list').getAttribute('style')).toContain('minmax(114px, 1fr)');
  });
});
