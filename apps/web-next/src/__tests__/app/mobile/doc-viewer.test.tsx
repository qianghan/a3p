/**
 * The document viewer over a mocked global fetch: the real getDoc / patchDoc / categorizeDoc / archiveDoc /
 * deleteDoc / reviewSuggestions / confirmDoc run, so the exact method, URL and body of every write is asserted,
 * and failures come from real HTTP answers rather than from a mocked module. The mock server keeps one expense
 * row, applies the writes to it, and answers re-reads from it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { moneyText, ToastHost } from '@/app/app/_kit';
import { RECENTS_KEY } from '@/app/app/_lib/category-recents';
import { jsonResponse, routeFetch } from './test-utils';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);
const nav = vi.hoisted(() => ({ id: 'e2', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  useParams: () => ({ id: nav.id }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/app/docs/${nav.id}`,
}));

import DocViewerPage from '@/app/app/docs/[id]/page';
import { DOC_VIEWER_ROUTE_SHIPPED } from '@/app/app/_home/RecentActivity';
import './_load-tolerance';

const EXP = '/api/v1/agentbook-expense/expenses';
const CORE = '/api/v1/agentbook-core';
const NAV_KEY = 'ab:mobile:docs:nav';
const ok = (data: unknown) => jsonResponse(200, { success: true, data });
const fail = (status: number, error = 'boom') => jsonResponse(status, { success: false, error });

type Raw = Record<string, unknown>;
const rawRow = (o: Raw = {}): Raw => ({
  id: 'e2', date: '2026-10-01', amountCents: 4700, vendorName: 'Blue Bottle', description: null,
  categoryId: 'c1', categoryName: 'Meals', confidence: null, status: 'confirmed', isPersonal: false,
  receiptUrl: null, receiptStatus: 'pending', archivedAt: null, journalEntryId: 'j1', ...o,
});
const SUGGEST = { categoryId: 'c5', categoryName: 'Travel', confidence: 0.82 };
const CATS = [
  { id: 'c1', name: 'Meals', code: '5200' },
  { id: 'c5', name: 'Travel', code: '5100' },
  { id: 'c9', name: 'Uncategorized Expenses', code: '6999' },
];
const nameOf = (id: string) => CATS.find((c) => c.id === id)?.name ?? null;

type Handler = (url: string, init?: RequestInit) => Response | Error | Promise<Response>;
let row: Raw;
let pending: unknown[];
/** Per-test overrides, keyed `METHOD /sub` (e.g. 'PATCH ', 'POST /archive') or 'review' / 'pending'. */
let over: Record<string, Handler>;

function startServer(initial: Raw = rawRow(), opts: { pending?: unknown[] } = {}) {
  row = { ...initial };
  pending = opts.pending ?? [];
  over = {};
  return routeFetch({
    [`${EXP}/`]: (url, init) => {
      const rest = url.slice(EXP.length + 1);
      const slash = rest.indexOf('/');
      const sub = slash < 0 ? '' : rest.slice(slash);
      const key = `${init?.method ?? 'GET'} ${sub}`;
      if (over[key]) return over[key](url, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as Raw) : {};
      switch (key) {
        case 'GET ':
          return ok(row);
        case 'PATCH ': {
          if ('amountCents' in body) row.amountCents = body.amountCents;
          if ('vendor' in body) row.vendorName = body.vendor;
          if ('date' in body) row.date = body.date;
          if ('description' in body) row.description = body.description;
          if ('isPersonal' in body) row.isPersonal = body.isPersonal;
          return ok(row);
        }
        case 'POST /categorize':
          row.categoryId = body.categoryId;
          row.categoryName = nameOf(String(body.categoryId));
          row.confidence = 1;
          delete row.suggestion;
          return ok(row);
        case 'POST /confirm':
          row.status = 'confirmed';
          return ok(row);
        case 'POST /archive':
          row.archivedAt = '2026-10-07T10:00:00.000Z';
          return ok({ id: row.id, archivedAt: row.archivedAt });
        case 'POST /unarchive':
          row.archivedAt = null;
          return ok({ id: row.id, archivedAt: null });
        case 'DELETE ':
          return ok({ id: row.id });
        default:
          return fail(404, `unmocked ${key}`);
      }
    },
    [`${CORE}/tenant-config`]: () => ok({ currency: 'CAD', jurisdiction: 'ca' }),
    [`${CORE}/accounts`]: () => ok(CATS),
    [`${CORE}/auto-categorize/pending`]: (url, init) => (over.pending ? over.pending(url, init) : ok({ items: pending, uncategorizedCount: pending.length })),
    [`${CORE}/auto-categorize/review`]: (url, init) => {
      if (over.review) return over.review(url, init);
      // The server applies ITS stored suggestion.
      row.categoryId = SUGGEST.categoryId;
      row.categoryName = SUGGEST.categoryName;
      row.confidence = SUGGEST.confidence;
      delete row.suggestion;
      return ok({ results: [{ expenseId: row.id, ok: true }] });
    },
  });
}

type Fetch = ReturnType<typeof routeFetch>;
/** Every non-GET request the page made: "METHOD path body", in order. */
const writes = (f: Fetch) =>
  f.mock.calls
    .filter((c) => (c[1]?.method ?? 'GET') !== 'GET')
    .map((c) => `${c[1]?.method} ${String(c[0])}${c[1]?.body ? ` ${String(c[1].body)}` : ''}`);
const detailGets = (f: Fetch) => f.mock.calls.filter((c) => String(c[0]) === `${EXP}/${nav.id}` && (c[1]?.method ?? 'GET') === 'GET').length;
/** A promise the test settles by hand, to hold a request in flight. */
function hold(): { promise: Promise<Response>; release: (r: Response) => void } {
  let release!: (r: Response) => void;
  const promise = new Promise<Response>((res) => { release = res; });
  return { promise, release };
}

const money = (cents: number) => moneyText(cents, 'CAD', 'en');
const renderViewer = () => render(<ToastHost><DocViewerPage /></ToastHost>);
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
const goOffline = () => { setOnline(false); fireEvent(window, new Event('offline')); };
const goOnline = () => { setOnline(true); fireEvent(window, new Event('online')); };
const amountShown = () => screen.getByTestId('doc-amount');
/** The document and the tenant currency have both arrived. */
async function ready(cents = 4700) {
  await screen.findByTestId('doc-amount');
  await waitFor(() => expect(amountShown()).toHaveTextContent(money(cents)));
}
const btn = (text: string) => screen.getByText(text).closest('button') as HTMLButtonElement;
const isLocked = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const savedNav = () => JSON.parse(sessionStorage.getItem(NAV_KEY)!) as { ids: string[]; filter: string; q: string };
const seedNav = (ids: string[], filter = 'all', q = '') => sessionStorage.setItem(NAV_KEY, JSON.stringify({ ids, filter, q }));
const recents = () => JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as { id: string; name: string }[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setOnline(true);
  nav.id = 'e2';
  nav.push.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('viewer — the route is live', () => {
  it('Home links straight to the viewer now that it exists', () => {
    expect(DOC_VIEWER_ROUTE_SHIPPED).toBe(true);
  });
});

describe('viewer — display', () => {
  it('shows vendor, tenant-currency amount, category and the AI pill for AI-categorized docs', async () => {
    startServer(rawRow({ confidence: 0.8 }));
    renderViewer();
    await ready();
    expect(screen.getByText('Blue Bottle')).toBeInTheDocument();
    expect(screen.getByTestId('doc-category')).toHaveTextContent('Meals');
    expect(within(screen.getByTestId('doc-category')).getByText('AI')).toBeInTheDocument();
  });

  it('shows a dash, never a guessed $0.00, until the currency is known', async () => {
    const f = startServer();
    const real = f.getMockImplementation()!;
    f.mockImplementation(async (input, init) => (String(input).startsWith(`${CORE}/tenant-config`) ? new Promise<Response>(() => {}) : real(input, init)));
    renderViewer();
    const amount = await screen.findByTestId('doc-amount');
    expect(amount).toHaveTextContent('—');
    expect(amount.textContent).not.toMatch(/\$|NaN|0\.00/);
  });

  it('a PDF receipt is a link, an image is the zoom viewer, and no receipt is a plain tile', async () => {
    startServer(rawRow({ receiptUrl: 'https://a.public.blob.vercel-storage.com/r/1.pdf' }));
    const first = renderViewer();
    const link = await screen.findByText('Open the PDF receipt');
    expect(link.closest('a')).toHaveAttribute('href', 'https://a.public.blob.vercel-storage.com/r/1.pdf');
    expect(link.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
    first.unmount();

    startServer(rawRow({ receiptUrl: 'https://a.public.blob.vercel-storage.com/r/1.jpg' }));
    const second = renderViewer();
    expect(await screen.findByTestId('pinch-zoom-img')).toHaveAttribute('src', 'https://a.public.blob.vercel-storage.com/r/1.jpg');
    second.unmount();

    startServer(rawRow());
    renderViewer();
    expect(await screen.findByTestId('no-receipt-tile')).toHaveTextContent('No receipt attached');
  });

  it('never puts a javascript: receipt URL in an href: it is shown as no receipt', async () => {
    startServer(rawRow({ receiptUrl: 'javascript:alert(1)//x.pdf' }));
    renderViewer();
    expect(await screen.findByTestId('no-receipt-tile')).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('a receipt image that fails to load says so, with Retry, instead of an empty box', async () => {
    startServer(rawRow({ receiptUrl: 'https://a.public.blob.vercel-storage.com/r/1.jpg' }));
    renderViewer();
    const img = await screen.findByTestId('pinch-zoom-img');
    fireEvent.error(img);
    expect(await screen.findByText('Couldn’t load the receipt image.')).toBeInTheDocument();
    expect(screen.queryByTestId('pinch-zoom-img')).toBeNull();
    fireEvent.click(btn('Retry'));
    const again = await screen.findByTestId('pinch-zoom-img');
    expect(again).not.toBe(img); // a fresh element: the browser tries the request again
    expect(screen.queryByText('Couldn’t load the receipt image.')).toBeNull();
  });

  it('offline, the failed image says why, Retry is inert, and coming back online retries by itself', async () => {
    startServer(rawRow({ receiptUrl: 'https://a.public.blob.vercel-storage.com/r/1.jpg' }));
    renderViewer();
    await ready();
    goOffline();
    fireEvent.error(await screen.findByTestId('pinch-zoom-img'));
    expect(await screen.findByText('You’re offline. Reconnect to load the receipt image.')).toBeInTheDocument();
    const retry = btn('Retry');
    expect(isLocked(retry)).toBe(true);
    expect(retry).not.toBeDisabled(); // aria-disabled keeps focus
    fireEvent.click(retry);
    expect(screen.queryByTestId('pinch-zoom-img')).toBeNull();
    goOnline();
    expect(await screen.findByTestId('pinch-zoom-img')).toBeInTheDocument();
  });

  it('shows "no longer exists" for a 404 — even when an offline copy of it exists', async () => {
    startServer();
    over['GET '] = () => fail(404, 'Expense not found');
    localStorage.setItem('ab:mobile:doc:e2', JSON.stringify({ savedAt: '2026-10-07T10:00:00.000Z', data: { id: 'e2', date: '2026-10-01', amountCents: 4700, vendorName: 'Ghost', description: null, categoryId: 'c1', categoryName: 'Meals', categorySource: 'user', confidence: null, status: 'confirmed', isPersonal: false, receiptUrl: null, receiptStatus: null, archivedAt: null, suggestion: null, booked: true } }));
    renderViewer();
    expect(await screen.findByText('This document no longer exists.')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-amount')).toBeNull();
    expect(screen.queryByText('Ghost')).toBeNull();
  });

  it('a server error is retryable and never shows the server’s own message', async () => {
    const f = startServer();
    let first = true;
    over['GET '] = () => {
      if (first) { first = false; return fail(500, 'secret stack trace'); }
      return ok(row);
    };
    renderViewer();
    expect(await screen.findByText('Couldn’t load this document.')).toBeInTheDocument();
    expect(screen.queryByText(/secret stack trace/)).toBeNull();
    fireEvent.click(btn('Retry'));
    await ready();
    expect(detailGets(f)).toBe(2);
  });

  it('a lost session offers sign-in, not a retry loop', async () => {
    startServer();
    over['GET '] = () => jsonResponse(401, { success: false, error: 'invalid session' });
    renderViewer();
    expect(await screen.findByText('You’ve been signed out')).toBeInTheDocument();
    expect(screen.getByText('Sign in again').closest('a')).toHaveAttribute('href', '/login?redirect=%2Fapp%2Fdocs%2Fe2');
    expect(screen.queryByText(/invalid session/)).toBeNull();
  });

  it('offline with no copy of the document says offline, not "failed"', async () => {
    setOnline(false);
    startServer();
    over['GET '] = () => new Error('network down');
    renderViewer();
    expect(await screen.findByText('You’re offline')).toBeInTheDocument();
  });
});

describe('viewer — navigation', () => {
  it('links prev/next across the saved filtered list, and Back to that list', async () => {
    seedNav(['e1', 'e2', 'e3'], 'no-receipt');
    startServer();
    renderViewer();
    await ready();
    expect(screen.getByLabelText('Previous document')).toHaveAttribute('href', '/app/docs/e1');
    expect(screen.getByLabelText('Next document')).toHaveAttribute('href', '/app/docs/e3');
    expect(screen.getByLabelText('Back to documents')).toHaveAttribute('href', '/app/docs?filter=no-receipt');
  });

  it('Back keeps the search too, and is a real link (the list remounts and re-reads)', async () => {
    seedNav(['e2'], 'needs-review', 'coffee shop');
    startServer();
    renderViewer();
    await ready();
    const back = screen.getByLabelText('Back to documents');
    expect(back.tagName).toBe('A');
    expect(back).toHaveAttribute('href', '/app/docs?filter=needs-review&q=coffee+shop');
  });

  it('the first document has no Previous and the last has no Next', async () => {
    seedNav(['e2', 'e3']);
    startServer();
    const first = renderViewer();
    await ready();
    expect(screen.queryByLabelText('Previous document')).toBeNull();
    expect(screen.getByLabelText('Next document')).toBeInTheDocument();
    first.unmount();

    seedNav(['e1', 'e2']);
    startServer();
    renderViewer();
    await ready();
    expect(screen.getByLabelText('Previous document')).toBeInTheDocument();
    expect(screen.queryByLabelText('Next document')).toBeNull();
  });

  it('encodes ids in prev/next hrefs', async () => {
    nav.id = 'x y';
    seedNav(['w/1', 'x y', 'z&2']);
    startServer(rawRow({ id: 'x y' }));
    renderViewer();
    await ready();
    expect(screen.getByLabelText('Previous document')).toHaveAttribute('href', '/app/docs/w%2F1');
    expect(screen.getByLabelText('Next document')).toHaveAttribute('href', '/app/docs/z%262');
  });

  it('a list that never held this document is not used (a deep link from Home keeps no stale filter)', async () => {
    seedNav(['a1', 'a2', 'a3'], 'archived', 'old search');
    startServer();
    renderViewer();
    await ready();
    expect(screen.queryByLabelText('Previous document')).toBeNull();
    expect(screen.queryByLabelText('Next document')).toBeNull();
    expect(screen.getByLabelText('Back to documents')).toHaveAttribute('href', '/app/docs');
  });
});

describe('viewer — editing', () => {
  it('Save is inert until dirty, then PATCHes only the change and shows the server result', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    renderViewer();
    await ready();
    const save = btn('Save changes');
    expect(isLocked(save)).toBe(true);
    fireEvent.click(save);
    expect(writes(f)).toEqual([]);
    fireEvent.change(input('Amount'), { target: { value: '52.50' } });
    expect(isLocked(save)).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(amountShown()).toHaveTextContent(money(5250)));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(writes(f)).toEqual([`PATCH ${EXP}/e2 {"amountCents":5250}`]);
    expect(isLocked(btn('Save changes'))).toBe(true); // clean again
    expect(input('Amount')).toHaveValue('52.50');
  });

  it('edits vendor, date, note and personal together — and never sends a category', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    renderViewer();
    await ready();
    fireEvent.change(input('Vendor'), { target: { value: 'BB Coffee' } });
    fireEvent.change(input('Date'), { target: { value: '2026-09-30' } });
    fireEvent.change(input('Note'), { target: { value: 'Client' } });
    fireEvent.click(input('Personal expense (not deductible)'));
    fireEvent.click(btn('Save changes'));
    await screen.findByText('Saved');
    expect(writes(f)).toEqual([`PATCH ${EXP}/e2 {"vendor":"BB Coffee","date":"2026-09-30","description":"Client","isPersonal":true}`]);
  });

  it('a booked expense stays editable: the server reverses and re-posts its entry, so only the changed field is sent', async () => {
    const f = startServer(rawRow({ status: 'confirmed', journalEntryId: 'j1' }));
    renderViewer();
    await ready();
    expect(input('Amount')).not.toHaveAttribute('readonly');
    expect(input('Date')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Personal expense (not deductible)')).not.toHaveAttribute('aria-disabled');
    fireEvent.change(input('Amount'), { target: { value: '60' } });
    fireEvent.click(btn('Save changes'));
    await waitFor(() => expect(amountShown()).toHaveTextContent(money(6000)));
    expect(writes(f)).toEqual([`PATCH ${EXP}/e2 {"amountCents":6000}`]);
  });

  it('rolls back the displayed amount on failure, keeps the typed value, toasts, and asks the server what happened', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    over['PATCH '] = () => fail(500);
    renderViewer();
    await ready();
    const before = detailGets(f);
    fireEvent.change(input('Amount'), { target: { value: '99.00' } });
    fireEvent.click(btn('Save changes'));
    expect(await screen.findByText('Couldn’t save your changes. Try again.')).toBeInTheDocument();
    expect(amountShown()).toHaveTextContent(money(4700));
    expect(input('Amount')).toHaveValue('99.00');
    expect(isLocked(btn('Save changes'))).toBe(false); // Retry is one tap
    await waitFor(() => expect(detailGets(f)).toBe(before + 1)); // the write may have landed: re-read
    expect(input('Amount')).toHaveValue('99.00'); // the re-read did not eat the typed value
  });

  it('a refused edit (closed period / split entry) says so instead of "try again"', async () => {
    startServer();
    over['PATCH '] = () => jsonResponse(422, { success: false, error: 'Period gate violated' });
    renderViewer();
    await ready();
    fireEvent.change(input('Amount'), { target: { value: '10' } });
    fireEvent.click(btn('Save changes'));
    expect(await screen.findByText(/closed period, split, or already reversed/)).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t save your changes. Try again.')).toBeNull();
  });

  it('blocks an invalid amount with a message, focus and no request', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    renderViewer();
    await ready();
    fireEvent.change(input('Amount'), { target: { value: 'abc' } });
    fireEvent.click(btn('Save changes'));
    expect((await screen.findByText('Enter an amount like 12.50')).getAttribute('role')).toBe('alert');
    expect(input('Amount')).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(input('Amount'));
    expect(writes(f)).toEqual([]);
    fireEvent.change(input('Amount'), { target: { value: '12.5' } });
    expect(screen.queryByText('Enter an amount like 12.50')).toBeNull();
  });

  it('an emptied vendor is refused with a message, not silently ignored', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    fireEvent.change(input('Vendor'), { target: { value: '  ' } });
    fireEvent.click(btn('Save changes'));
    expect(await screen.findByText('A vendor name can’t be empty.')).toBeInTheDocument();
    expect(writes(f)).toEqual([]);
  });

  it('a double tap on Save sends one request', async () => {
    const f = startServer();
    const held = hold();
    over['PATCH '] = () => held.promise;
    renderViewer();
    await ready();
    fireEvent.change(input('Amount'), { target: { value: '55' } });
    const save = btn('Save changes');
    fireEvent.click(save);
    fireEvent.click(save);
    expect(writes(f)).toHaveLength(1);
    expect(screen.getByText('Saving…').closest('button')).toHaveAttribute('aria-busy', 'true');
    expect(input('Amount')).toHaveAttribute('readonly'); // nothing typed mid-flight can be overwritten by the answer
    row.amountCents = 5500;
    held.release(ok(row));
    await screen.findByText('Saved');
    expect(writes(f)).toHaveLength(1);
  });

  it('a background refresh (back online) does not eat what the user typed', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    fireEvent.change(input('Note'), { target: { value: 'half-typed' } });
    const before = detailGets(f);
    goOffline();
    goOnline();
    await waitFor(() => expect(detailGets(f)).toBe(before + 1));
    await act(async () => {});
    expect(input('Note')).toHaveValue('half-typed');
  });

  it('is read-only offline: fields locked, every write button inert, no request goes out', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    renderViewer();
    await ready();
    fireEvent.change(input('Amount'), { target: { value: '70' } });
    goOffline();
    await waitFor(() => expect(input('Amount')).toHaveAttribute('readonly'));
    expect(input('Vendor')).toHaveAttribute('readonly');
    expect(input('Date')).toHaveAttribute('readonly');
    expect(input('Note')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Personal expense (not deductible)')).toHaveAttribute('aria-disabled', 'true');
    for (const label of ['Save changes', 'Archive', 'Delete', 'Mark as reviewed', 'Change category']) {
      const b = btn(label);
      expect(isLocked(b), label).toBe(true);
      expect(b, label).not.toBeDisabled();
      fireEvent.click(b);
    }
    expect(screen.queryByRole('dialog')).toBeNull(); // neither the picker nor the delete sheet opened
    expect(writes(f)).toEqual([]);
    expect(screen.getByText(/You’re offline|Offline/)).toBeInTheDocument();
  });
});

describe('viewer — categorization', () => {
  it('shows the AI suggestion with its confidence', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    renderViewer();
    const chip = await screen.findByTestId('ai-suggestion');
    expect(chip).toHaveTextContent('Suggested: Travel');
    expect(chip).toHaveTextContent('82% sure');
    expect(screen.queryByRole('dialog')).toBeNull(); // a suggestion means no automatic picker
  });

  it('accepting sends a BARE accept — never a category id — then shows what the server did', async () => {
    const f = startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    renderViewer();
    const chip = await screen.findByTestId('ai-suggestion');
    fireEvent.click(within(chip).getByText('Accept'));
    await waitFor(() => expect(screen.getByTestId('doc-category')).toHaveTextContent('Travel'));
    expect(writes(f)).toEqual([`POST ${CORE}/auto-categorize/review {"items":[{"expenseId":"e2","action":"accept"}]}`]);
    expect(writes(f)[0]).not.toContain('categoryId');
    expect(screen.queryByTestId('ai-suggestion')).toBeNull();
    expect(await screen.findByText('Category updated')).toBeInTheDocument();
    expect(recents()[0]).toEqual({ id: 'c5', name: 'Travel' });
    expect(document.activeElement).toBe(btn('Change category')); // focus did not fall to <body>
  });

  it('shows the AI pick optimistically while the server works, and a double tap sends one accept', async () => {
    const f = startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    const held = hold();
    over.review = () => held.promise;
    renderViewer();
    const chip = await screen.findByTestId('ai-suggestion');
    const accept = within(chip).getByText('Accept').closest('button')!;
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(screen.getByTestId('doc-category')).toHaveTextContent('Travel');
    expect(recents()).toEqual([]); // nothing is remembered until it is saved
    expect(writes(f)).toHaveLength(1);
    row.categoryId = 'c5'; row.categoryName = 'Travel'; row.confidence = 0.82; delete row.suggestion;
    held.release(ok({ results: [{ expenseId: 'e2', ok: true }] }));
    await waitFor(() => expect(recents()).toHaveLength(1));
    expect(writes(f)).toHaveLength(1);
  });

  it('puts the category back and toasts when the accept fails', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    over.review = () => ok({ results: [{ expenseId: 'e2', ok: false, error: 'failed' }] });
    renderViewer();
    fireEvent.click(within(await screen.findByTestId('ai-suggestion')).getByText('Accept'));
    expect(await screen.findByText('Couldn’t change the category. It was put back.')).toBeInTheDocument();
    expect(screen.getByTestId('doc-category')).toHaveTextContent('No category');
    expect(screen.getByTestId('ai-suggestion')).toBeInTheDocument(); // the pick is still there to try again
    expect(recents()).toEqual([]);
  });

  it('a pick the server no longer holds (still uncategorized) is dropped, not offered again', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    over.review = () => ok({ results: [{ expenseId: 'e2', ok: false, error: 'no_suggestion' }] });
    renderViewer();
    fireEvent.click(within(await screen.findByTestId('ai-suggestion')).getByText('Accept'));
    expect(await screen.findByText('Couldn’t change the category. It was put back.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('ai-suggestion')).toBeNull());
    expect(screen.getByTestId('doc-category')).toHaveTextContent('No category');
  });

  it('no_suggestion on an expense categorized elsewhere shows the server’s category and remembers no recent', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null, suggestion: SUGGEST }));
    over.review = () => {
      row.categoryId = 'c1'; row.categoryName = 'Meals'; row.confidence = 1; delete row.suggestion;
      return ok({ results: [{ expenseId: 'e2', ok: false, error: 'no_suggestion' }] });
    };
    renderViewer();
    fireEvent.click(within(await screen.findByTestId('ai-suggestion')).getByText('Accept'));
    await waitFor(() => expect(screen.getByTestId('doc-category')).toHaveTextContent('Meals'));
    expect(recents()).toEqual([]);
  });

  it('falls back to the pending-suggestions route when the doc carries none', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null }), {
      pending: [{ expenseId: 'e2', vendorName: 'Blue Bottle', amountCents: 4700, date: '2026-10-01', description: null, suggestedCategoryId: 'c1', suggestedCategoryName: 'Meals', confidence: 0.7 }],
    });
    renderViewer();
    expect(await screen.findByTestId('ai-suggestion')).toHaveTextContent('Suggested: Meals');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not open the picker until the pending-suggestion check is done, then not at all if one arrives', async () => {
    const f = startServer(rawRow({ categoryId: null, categoryName: null }));
    const held = hold();
    over.pending = () => held.promise;
    renderViewer();
    await ready();
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).startsWith(`${CORE}/auto-categorize/pending`))).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    held.release(ok({ uncategorizedCount: 1, items: [{ expenseId: 'e2', vendorName: 'x', amountCents: 1, date: '2026-10-01', description: null, suggestedCategoryId: 'c5', suggestedCategoryName: 'Travel', confidence: 0.9 }] }));
    expect(await screen.findByTestId('ai-suggestion')).toHaveTextContent('Travel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the picker for an uncategorized doc with no suggestion; the sheet closes first, recents follow the save', async () => {
    const f = startServer(rawRow({ categoryId: null, categoryName: null }));
    const held = hold();
    over['POST /categorize'] = () => held.promise;
    renderViewer();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    fireEvent.click(await within(dialog).findByText('Meals'));
    expect(screen.queryByRole('dialog')).toBeNull(); // closed synchronously, before the answer
    expect(screen.getByTestId('doc-category')).toHaveTextContent('Meals'); // optimistic
    expect(recents()).toEqual([]);
    row.categoryId = 'c1'; row.categoryName = 'Meals'; row.confidence = 1;
    held.release(ok(row));
    await waitFor(() => expect(recents()).toEqual([{ id: 'c1', name: 'Meals' }]));
    expect(writes(f)).toEqual([`POST ${EXP}/e2/categorize {"categoryId":"c1","source":"user"}`]);
    expect(await screen.findByText('Category updated')).toBeInTheDocument();
  });

  it('the suspense account is never offered', async () => {
    startServer(rawRow({ categoryId: null, categoryName: null }));
    renderViewer();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    await within(dialog).findByText('Travel');
    expect(within(dialog).queryByText('Uncategorized Expenses')).toBeNull();
  });

  it('does not open the picker by itself offline, for an archived doc, or twice', async () => {
    setOnline(false);
    startServer(rawRow({ categoryId: null, categoryName: null }));
    const offline = renderViewer();
    await ready();
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    offline.unmount();

    setOnline(true);
    startServer(rawRow({ categoryId: null, categoryName: null, archivedAt: '2026-10-05T00:00:00.000Z' }));
    const archived = renderViewer();
    await ready();
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    archived.unmount();

    startServer(rawRow({ categoryId: null, categoryName: null }));
    renderViewer();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    fireEvent.click(within(dialog).getByLabelText('Close'));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull(); // closed by the user: it stays closed
  });

  it('changing a category rolls back, toasts, and remembers nothing when it fails', async () => {
    startServer();
    over['POST /categorize'] = () => fail(500);
    renderViewer();
    await ready();
    fireEvent.click(btn('Change category'));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    fireEvent.click(await within(dialog).findByText('Travel'));
    expect(await screen.findByText('Couldn’t change the category. It was put back.')).toBeInTheDocument();
    expect(screen.getByTestId('doc-category')).toHaveTextContent('Meals');
    expect(recents()).toEqual([]);
  });

  it('picking the category it already has changes nothing', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    fireEvent.click(btn('Change category'));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    fireEvent.click(await within(dialog).findByText('Meals'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(f)).toEqual([]);
  });

  it('Mark as reviewed confirms a categorized pending_review doc and moves focus off the vanishing button', async () => {
    const f = startServer(rawRow({ status: 'pending_review' }));
    renderViewer();
    await ready();
    fireEvent.click(btn('Mark as reviewed'));
    expect(await screen.findByText('Marked as reviewed')).toBeInTheDocument();
    expect(writes(f)).toEqual([`POST ${EXP}/e2/confirm {}`]);
    expect(screen.queryByText('Mark as reviewed')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('Blue Bottle'));
  });

  it('Mark as reviewed puts the status back when the confirm fails', async () => {
    startServer(rawRow({ status: 'pending_review' }));
    over['POST /confirm'] = () => fail(500);
    renderViewer();
    await ready();
    fireEvent.click(btn('Mark as reviewed'));
    expect(await screen.findByText('Couldn’t mark this as reviewed. Try again.')).toBeInTheDocument();
    expect(btn('Mark as reviewed')).toBeInTheDocument();
  });

  it('Mark as reviewed refuses without a category (confirm would skip the journal)', async () => {
    const f = startServer(rawRow({ status: 'pending_review', categoryId: null, categoryName: null, suggestion: SUGGEST }));
    renderViewer();
    await screen.findByTestId('ai-suggestion');
    const review = btn('Mark as reviewed');
    expect(isLocked(review)).toBe(true);
    fireEvent.click(review);
    expect(screen.getByText('Pick a category before marking this reviewed.')).toBeInTheDocument();
    expect(writes(f)).toEqual([]);
  });

  it('Mark as reviewed is not offered on an already confirmed doc', async () => {
    startServer(rawRow({ status: 'confirmed' }));
    renderViewer();
    await ready();
    expect(screen.queryByText('Mark as reviewed')).toBeNull();
  });
});

describe('viewer — archive and delete', () => {
  it('archives then restores, with the exact requests', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    fireEvent.click(btn('Archive'));
    expect(await screen.findByText('Archived — totals are unchanged')).toBeInTheDocument();
    expect(screen.getByText('Archived. It is hidden from your lists but its numbers still count.')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Restore'));
    expect(await screen.findByText('Restored')).toBeInTheDocument();
    expect(btn('Archive')).toBeInTheDocument();
    expect(writes(f)).toEqual([`POST ${EXP}/e2/archive`, `POST ${EXP}/e2/unarchive`]);
  });

  it('archiving drops the document from the list order it came from; restoring from Archived does too', async () => {
    seedNav(['e1', 'e2', 'e3'], 'needs-review');
    startServer();
    const first = renderViewer();
    await ready();
    fireEvent.click(btn('Archive'));
    await screen.findByText('Archived — totals are unchanged');
    expect(savedNav().ids).toEqual(['e1', 'e3']);
    expect(screen.getByLabelText('Next document')).toHaveAttribute('href', '/app/docs/e3'); // this screen keeps its neighbours
    first.unmount();

    seedNav(['e1', 'e2', 'e3'], 'archived');
    startServer(rawRow({ archivedAt: '2026-10-05T00:00:00.000Z' }));
    renderViewer();
    await ready();
    fireEvent.click(btn('Restore'));
    await screen.findByText('Restored');
    expect(savedNav().ids).toEqual(['e1', 'e3']);
  });

  it('archiving from the Archived list, or restoring in a normal list, leaves the order alone', async () => {
    seedNav(['e1', 'e2', 'e3'], 'archived');
    startServer(rawRow({ archivedAt: null }));
    const first = renderViewer();
    await ready();
    fireEvent.click(btn('Archive')); // already in the Archived list order: stays
    await screen.findByText('Archived — totals are unchanged');
    expect(savedNav().ids).toEqual(['e1', 'e2', 'e3']);
    first.unmount();

    seedNav(['e1', 'e2', 'e3'], 'all');
    startServer(rawRow({ archivedAt: '2026-10-05T00:00:00.000Z' }));
    renderViewer();
    await ready();
    fireEvent.click(btn('Restore'));
    await screen.findByText('Restored');
    expect(savedNav().ids).toEqual(['e1', 'e2', 'e3']);
  });

  it('rolls back an archive that fails and leaves the order alone', async () => {
    seedNav(['e1', 'e2']);
    startServer();
    over['POST /archive'] = () => fail(500);
    renderViewer();
    await ready();
    fireEvent.click(btn('Archive'));
    expect(await screen.findByText('Couldn’t archive. Try again.')).toBeInTheDocument();
    expect(btn('Archive')).toBeInTheDocument();
    expect(savedNav().ids).toEqual(['e1', 'e2']);
  });

  it('rolls back a restore that fails', async () => {
    startServer(rawRow({ archivedAt: '2026-10-05T00:00:00.000Z' }));
    over['POST /unarchive'] = () => fail(500);
    renderViewer();
    await ready();
    fireEvent.click(btn('Restore'));
    expect(await screen.findByText('Couldn’t restore. Try again.')).toBeInTheDocument();
    expect(btn('Restore')).toBeInTheDocument();
  });

  it('a double tap on Archive sends one request', async () => {
    const f = startServer();
    const held = hold();
    over['POST /archive'] = () => held.promise;
    renderViewer();
    await ready();
    const archive = btn('Archive');
    fireEvent.click(archive);
    fireEvent.click(btn('Restore')); // the label already flipped (optimistic): it must not un-archive mid-flight
    expect(writes(f)).toEqual([`POST ${EXP}/e2/archive`]);
    held.release(ok({ id: 'e2', archivedAt: '2026-10-07T10:00:00.000Z' }));
    await screen.findByText('Archived — totals are unchanged');
    expect(writes(f)).toHaveLength(1);
  });

  it('deletes only after confirming, then moves to the next document and forgets the deleted one', async () => {
    seedNav(['e2', 'e3']);
    const f = startServer();
    localStorage.setItem('ab:mobile:doc:e2', '{}');
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    expect(writes(f)).toEqual([]);
    const dialog = screen.getByRole('dialog', { name: 'Delete this expense?' });
    fireEvent.click(within(dialog).getByText('Delete expense'));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/app/docs/e3'));
    expect(writes(f)).toEqual([`DELETE ${EXP}/e2`]);
    expect(savedNav().ids).toEqual(['e3']);
    expect(localStorage.getItem('ab:mobile:doc:e2')).toBeNull();
    expect(await screen.findByText('Deleted')).toBeInTheDocument();
  });

  it('deleting the last document of the list goes back to that list', async () => {
    seedNav(['e1', 'e2'], 'no-receipt');
    startServer();
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this expense?' })).getByText('Delete expense'));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/app/docs?filter=no-receipt'));
    expect(savedNav().ids).toEqual(['e1']);
  });

  it('cancel in the delete sheet does nothing', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this expense?' })).getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(f)).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('waits for the server: the sheet cannot be dismissed mid-delete and a double tap sends one DELETE', async () => {
    seedNav(['e2', 'e3']);
    const f = startServer();
    const held = hold();
    over['DELETE '] = () => held.promise;
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    const dialog = screen.getByRole('dialog', { name: 'Delete this expense?' });
    const confirm = within(dialog).getByText('Delete expense').closest('button')!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(writes(f)).toEqual([`DELETE ${EXP}/e2`]);
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Delete this expense?' })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled(); // not optimistic: nothing moved yet
    expect(savedNav().ids).toEqual(['e2', 'e3']);
    held.release(ok({ id: 'e2' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/app/docs/e3'));
  });

  it('a failed delete stays on the page, tells the user inside the dialog, and keeps the order', async () => {
    seedNav(['e2', 'e3']);
    startServer();
    over['DELETE '] = () => fail(500);
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    const dialog = screen.getByRole('dialog', { name: 'Delete this expense?' });
    fireEvent.click(within(dialog).getByText('Delete expense'));
    expect(await within(dialog).findByText('Couldn’t delete. Try again.')).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    expect(savedNav().ids).toEqual(['e2', 'e3']);
    expect(isLocked(within(dialog).getByText('Delete expense').closest('button')!)).toBe(false); // can try again
  });

  it('delete is unavailable offline', async () => {
    const f = startServer();
    renderViewer();
    await ready();
    goOffline();
    fireEvent.click(btn('Delete'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(f)).toEqual([]);
  });

  it('a delete that lost its answer but went through shows "no longer exists" on the re-read', async () => {
    startServer();
    over['DELETE '] = () => {
      row = { ...row, gone: true };
      over['GET '] = () => fail(404, 'Expense not found');
      return fail(500);
    };
    renderViewer();
    await ready();
    fireEvent.click(btn('Delete'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this expense?' })).getByText('Delete expense'));
    expect(await screen.findByText('This document no longer exists.')).toBeInTheDocument();
  });
});
