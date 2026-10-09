/**
 * The category picker through a mocked global fetch: the real listExpenseCategories (api.ts)
 * runs, so the request the phone sends and the server rows it accepts are asserted, and the
 * failure paths come from real HTTP answers rather than a mocked module.
 *
 * Queries use test ids, not getByRole: a 100-category list renders 100 buttons and a role
 * query computes an accessible name for each.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { RECENTS_KEY, pushRecentCategory, getRecentCategories } from '@/app/app/_lib/category-recents';
import { SNAPSHOT_PREFIX, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { CategoryPicker, foldForSearch, SUSPENSE_ACCOUNT_CODE } from '@/app/app/docs/_components/CategoryPicker';
import { jsonResponse, routeFetch } from './test-utils';
import './_load-tolerance';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);

const ACCOUNTS = '/api/v1/agentbook-core/accounts';
const ok = (data: unknown) => jsonResponse(200, { success: true, data });
// The shape the route really returns: whole AbAccount rows, extra fields included.
const row = (id: string, name: string, code: string) => ({ id, tenantId: 't1', code, name, accountType: 'expense', isActive: true, parentId: null });
const CATS = [
  row('c1', 'Travel', '5100'),
  row('c2', 'Meals', '5200'),
  row('c3', 'Advertising', '5000'),
  row('c4', 'Office Supplies', '5300'),
  row('c5', 'Café & Coffee', '5400'),
];
const SERVER = (id: string) => CATS.find((c) => c.id === id)!;
const asCategory = (r: ReturnType<typeof row>) => ({ id: r.id, name: r.name, code: r.code });

const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
const names = () => screen.queryAllByTestId('category-name').map((n) => n.textContent);
const ids = () => screen.queryAllByTestId('category-option').map((o) => o.getAttribute('data-category-id'));
const searchBox = () => screen.getByLabelText('Search categories') as HTMLInputElement;
const search = (value: string) => fireEvent.change(searchBox(), { target: { value } });
const listCalls = (f: ReturnType<typeof routeFetch>) => f.mock.calls.filter((c) => String(c[0]).startsWith(ACCOUNTS));
const retryButton = () => screen.getByText('Retry').closest('button') as HTMLButtonElement;

const mount = (props: Partial<React.ComponentProps<typeof CategoryPicker>> = {}) => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(<CategoryPicker open onClose={onClose} onSelect={onSelect} currentId={null} {...props} />);
  return { onSelect, onClose, ...view };
};

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
});

describe('CategoryPicker — what it asks for and shows', () => {
  it('requests the active expense accounts once, and nothing while closed', async () => {
    const f = routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    const { rerender } = render(<CategoryPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    expect(f).not.toHaveBeenCalled();
    rerender(<CategoryPicker open onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    await screen.findAllByTestId('category-option');
    expect(listCalls(f).map((c) => String(c[0]))).toEqual([`${ACCOUNTS}?type=expense`]);
  });

  it('lists recents first (in recency order), then the rest alphabetically, with name and code', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'c2', name: 'Meals' }, { id: 'c1', name: 'Travel' }]));
    routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(names()).toEqual(['Meals', 'Travel', 'Advertising', 'Café & Coffee', 'Office Supplies']);
    expect(ids()).toEqual(['c2', 'c1', 'c3', 'c5', 'c4']);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('All categories')).toBeInTheDocument();
    // the code is shown next to the name, so two accounts with one name can be told apart
    expect(within(screen.getAllByTestId('category-option')[0]).getByText('5200')).toBeInTheDocument();
  });

  it('shows exactly the accounts the server returned — a stored recent the server no longer returns is not offered', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'gone-1', name: 'Deactivated Account' }, { id: 'c3', name: 'Advertising' }]));
    routeFetch({ [ACCOUNTS]: () => ok([SERVER('c3'), SERVER('c1')]) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(ids()).toEqual(['c3', 'c1']);
    expect(screen.queryByText('Deactivated Account')).toBeNull();
  });

  it('renders a 100-category list in full without inventing, dropping or reordering rows', async () => {
    const many = Array.from({ length: 100 }, (_, i) => row(`id-${i}`, `Category ${String(i).padStart(3, '0')}`, String(6000 + i)));
    routeFetch({ [ACCOUNTS]: () => ok(many) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(ids()).toEqual(many.map((m) => m.id));
  });

  it('does not take focus on open: the dialog does, so the keyboard stays down', async () => {
    routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(document.activeElement).not.toBe(searchBox());
  });

  it('search input: type=search, capped at 100 characters, search enter key, labelled', async () => {
    routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    mount();
    const box = searchBox();
    expect(box).toHaveAttribute('type', 'search');
    expect(box).toHaveAttribute('maxlength', '100');
    expect(box).toHaveAttribute('enterkeyhint', 'search');
    expect(box.getAttribute('placeholder')).toBe('Search categories');
  });

  it('re-reads the list on every open: a category deactivated since is gone, and a late answer from the previous open is ignored', async () => {
    const pending: Array<(r: Response) => void> = [];
    routeFetch({ [ACCOUNTS]: () => new Promise<Response>((res) => { pending.push(res); }) });
    const { rerender } = mount();
    expect(pending).toHaveLength(1);
    rerender(<CategoryPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    rerender(<CategoryPicker open onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    expect(pending).toHaveLength(2);
    await act(async () => pending[0](ok([SERVER('c1')]))); // the first open's answer arrives late
    expect(ids()).toEqual([]);
    await act(async () => pending[1](ok([SERVER('c2')])));
    expect(ids()).toEqual(['c2']);
  });

  it('a list read on a previous open is not shown while the next open is loading (a deactivated account is never offered from memory)', async () => {
    let release!: (r: Response) => void;
    let n = 0;
    routeFetch({ [ACCOUNTS]: () => (n++ === 0 ? ok([SERVER('c1'), SERVER('c2')]) : new Promise<Response>((res) => { release = res; })) });
    const { rerender } = mount();
    await waitFor(() => expect(ids()).toEqual(['c2', 'c1']));
    rerender(<CategoryPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    rerender(<CategoryPicker open onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    expect(ids()).toEqual([]);
    expect(screen.getByTestId('category-loading')).toBeInTheDocument();
    await act(async () => release(ok([SERVER('c2')])));
    expect(ids()).toEqual(['c2']);
  });
});

describe('CategoryPicker — search', () => {
  beforeEach(() => { routeFetch({ [ACCOUNTS]: () => ok(CATS) }); });

  it('filters by name, case-insensitively', async () => {
    mount();
    await screen.findAllByTestId('category-option');
    search('OFFICE');
    expect(names()).toEqual(['Office Supplies']);
    search('off'); // substring, so the 'Coffee' account matches too
    expect(names()).toEqual(['Café & Coffee', 'Office Supplies']);
  });

  it('filters by account code', async () => {
    mount();
    await screen.findAllByTestId('category-option');
    search('5100');
    expect(names()).toEqual(['Travel']);
  });

  it('is diacritic-insensitive in both directions: "cafe" finds "Café", "CAFÉ" too', async () => {
    mount();
    await screen.findAllByTestId('category-option');
    search('cafe');
    expect(names()).toEqual(['Café & Coffee']);
    search('CAFÉ');
    expect(names()).toEqual(['Café & Coffee']);
  });

  it('applies to recents as well, and drops a heading with nothing under it', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'c2', name: 'Meals' }]));
    mount();
    await screen.findAllByTestId('category-option');
    search('meal');
    expect(names()).toEqual(['Meals']);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.queryByText('All categories')).toBeNull();
    search('office');
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.getByText('All categories')).toBeInTheDocument();
  });

  it('a search with no hit says so (not "no categories", not an error) and clearing it restores the list', async () => {
    mount();
    await screen.findAllByTestId('category-option');
    search('zzzz');
    expect(names()).toEqual([]);
    expect(screen.getAllByText('No matches')).toHaveLength(2); // the empty state and the live region
    expect(screen.getByText('Try a different search.')).toBeInTheDocument();
    expect(screen.queryByText('No expense categories yet')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    search('');
    expect(names()).toHaveLength(5);
  });

  it('announces the number of matches in a polite status region', async () => {
    mount();
    await screen.findAllByTestId('category-option');
    expect(screen.getByTestId('category-status')).toHaveTextContent('5 categories');
    search('trav');
    expect(screen.getByTestId('category-status')).toHaveTextContent('1 category');
    search('zzzz');
    expect(screen.getByTestId('category-status')).toHaveTextContent('No matches');
  });

  it('resets the search when the sheet is closed', async () => {
    const { rerender } = mount();
    await screen.findAllByTestId('category-option');
    search('trav');
    rerender(<CategoryPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    rerender(<CategoryPicker open onClose={vi.fn()} onSelect={vi.fn()} currentId={null} />);
    await screen.findAllByTestId('category-option');
    expect(searchBox().value).toBe('');
    expect(names()).toHaveLength(5);
  });
});

describe('CategoryPicker — selection', () => {
  it("returns the server's account verbatim (id, name, code) and marks the current one", async () => {
    routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    const { onSelect, onClose } = mount({ currentId: 'c1' });
    await screen.findAllByTestId('category-option');
    const travel = document.querySelector('[data-category-id="c1"]') as HTMLElement;
    const meals = document.querySelector('[data-category-id="c2"]') as HTMLElement;
    expect(travel).toHaveAttribute('aria-pressed', 'true');
    expect(meals).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(meals);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(asCategory(SERVER('c2')));
    expect(onSelect.mock.calls[0][0]).toEqual({ id: 'c2', name: 'Meals', code: '5200' });
    expect(onClose).not.toHaveBeenCalled(); // closing is the caller's decision
  });

  it('choosing is not committing: it does not write a recent (the caller does, once the save succeeds)', async () => {
    routeFetch({ [ACCOUNTS]: () => ok(CATS) });
    mount();
    await screen.findAllByTestId('category-option');
    fireEvent.click(document.querySelector('[data-category-id="c4"]') as HTMLElement);
    expect(getRecentCategories()).toEqual([]);
    expect(localStorage.getItem(RECENTS_KEY)).toBeNull();
  });

  it('keeps the id exact for ids that look alike', async () => {
    routeFetch({ [ACCOUNTS]: () => ok([row('0b1f-AAA', 'Fuel', '5500'), row('0b1f-aaa', 'Parking', '5510')]) });
    const { onSelect } = mount();
    await screen.findAllByTestId('category-option');
    fireEvent.click(document.querySelector('[data-category-id="0b1f-aaa"]') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith({ id: '0b1f-aaa', name: 'Parking', code: '5510' });
  });
});

describe('CategoryPicker — loading, failure and retry', () => {
  it('shows a placeholder while loading, then the list', async () => {
    let release!: (r: Response) => void;
    routeFetch({ [ACCOUNTS]: () => new Promise<Response>((res) => { release = res; }) });
    mount();
    expect(screen.getByTestId('category-loading')).toBeInTheDocument();
    expect(ids()).toEqual([]);
    await act(async () => release(ok(CATS)));
    expect(screen.queryByTestId('category-loading')).toBeNull();
    expect(ids()).toHaveLength(5);
  });

  it('a failed load shows the error and Retry — never an empty list, a "no categories" state, or recents from memory', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'c2', name: 'Meals' }]));
    routeFetch({ [ACCOUNTS]: () => new Error('Failed to fetch') });
    mount();
    expect(await screen.findByText('Couldn’t load categories.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(retryButton()).toBeInTheDocument();
    expect(ids()).toEqual([]); // not even the stored recent: only the server's list is ever offered
    expect(screen.queryByText('No expense categories yet')).toBeNull();
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('a server error (500) is a failure too, not an empty list', async () => {
    routeFetch({ [ACCOUNTS]: () => jsonResponse(500, { success: false, error: 'boom' }) });
    mount();
    expect(await screen.findByText('Couldn’t load categories.')).toBeInTheDocument();
    expect(ids()).toEqual([]);
  });

  it('Retry refetches: busy while in flight (and a second press is ignored), then the list, with focus kept inside the dialog', async () => {
    let call = 0;
    let release!: (r: Response) => void;
    const f = routeFetch({
      [ACCOUNTS]: () => {
        call += 1;
        if (call === 1) return new Error('Failed to fetch');
        return new Promise<Response>((res) => { release = res; });
      },
    });
    mount();
    await screen.findByText('Couldn’t load categories.');
    const button = retryButton();
    expect(button).not.toHaveAttribute('aria-busy');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(retryButton()).toHaveAttribute('aria-busy', 'true'));
    expect(retryButton()).toHaveAttribute('aria-disabled', 'true');
    expect(retryButton()).not.toBeDisabled();
    expect(document.activeElement).toBe(retryButton()); // aria-disabled, so focus did not fall to <body>
    fireEvent.click(retryButton());
    fireEvent.click(retryButton());
    expect(listCalls(f)).toHaveLength(2); // initial + ONE retry
    await act(async () => release(ok(CATS)));
    expect(ids()).toHaveLength(5);
    expect(screen.queryByText('Couldn’t load categories.')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('category-status')); // not <body>
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('a retry that fails again keeps the error and Retry, usable again', async () => {
    const f = routeFetch({ [ACCOUNTS]: () => new Error('Failed to fetch') });
    mount();
    await screen.findByText('Couldn’t load categories.');
    fireEvent.click(retryButton());
    await waitFor(() => expect(listCalls(f)).toHaveLength(2));
    await waitFor(() => expect(retryButton()).not.toHaveAttribute('aria-busy'));
    expect(screen.getByText('Couldn’t load categories.')).toBeInTheDocument();
    fireEvent.click(retryButton());
    await waitFor(() => expect(listCalls(f)).toHaveLength(3));
  });

  it('offline: says so, Retry is inert (aria-disabled, no request), and coming back online retries by itself', async () => {
    setOnline(false);
    let call = 0;
    const f = routeFetch({ [ACCOUNTS]: () => (++call === 1 ? new Error('Failed to fetch') : ok(CATS)) });
    mount();
    expect(await screen.findByText('Couldn’t load categories.')).toBeInTheDocument();
    expect(screen.getByText('You’re offline. Reconnect to load categories.')).toBeInTheDocument();
    expect(retryButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(retryButton());
    expect(listCalls(f)).toHaveLength(1);
    setOnline(true);
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(ids()).toHaveLength(5));
    expect(listCalls(f)).toHaveLength(2);
  });

  it('a server that really has no expense categories says so — distinct from a failure', async () => {
    routeFetch({ [ACCOUNTS]: () => ok([]) });
    mount();
    expect(await screen.findByText('No expense categories yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(ids()).toEqual([]);
  });

  it('ignores rows without a string id or name (the client never fabricates one)', async () => {
    routeFetch({ [ACCOUNTS]: () => ok([{ id: 7, name: 'Numeric id' }, { id: 'x', name: null }, { name: 'No id' }, SERVER('c1')]) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(ids()).toEqual(['c1']);
  });
});

describe('CategoryPicker — device storage, targets, tokens', () => {
  it('recents live under the ab:mobile: prefix and sign-out purges them', () => {
    expect(RECENTS_KEY.startsWith('ab:mobile:')).toBe(true);
    expect(RECENTS_KEY.startsWith(SNAPSHOT_PREFIX)).toBe(true);
    pushRecentCategory({ id: 'c1', name: 'Travel' });
    expect(getRecentCategories()).toEqual([{ id: 'c1', name: 'Travel' }]);
    clearMobileSnapshots();
    expect(getRecentCategories()).toEqual([]);
    expect(localStorage.getItem(RECENTS_KEY)).toBeNull();
  });

  it('every option and the Retry button are at least 44px tall', async () => {
    let call = 0;
    routeFetch({ [ACCOUNTS]: () => (++call === 1 ? new Error('x') : ok(CATS)) });
    mount();
    await screen.findByText('Retry');
    expect(parseFloat(retryButton().style.minHeight)).toBeGreaterThanOrEqual(44);
    fireEvent.click(retryButton());
    await screen.findAllByTestId('category-option');
    for (const o of screen.getAllByTestId('category-option')) expect(parseFloat(o.style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(searchBox().style.minHeight)).toBeGreaterThanOrEqual(42); // inside a 44px bordered label
    expect(parseFloat(searchBox().style.fontSize)).toBeGreaterThanOrEqual(16); // below 16px iOS zooms the page on focus
  });

  it('uses kit tokens only: no hex or rgb()/hsl() colour literals, and no disabled attribute on a button that can be pressed while busy', () => {
    const src = readFileSync(join(__dirname, '../../../app/app/docs/_components/CategoryPicker.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:rgba?|hsla?)\(/);
    expect(src).not.toMatch(/(?<![-\w])disabled=/);
    expect(src).not.toMatch(/autoFocus/);
  });
});

describe('foldForSearch', () => {
  it('lowercases and strips combining marks', () => {
    expect(foldForSearch('Café')).toBe('cafe');
    expect(foldForSearch('DÉPENSES')).toBe('depenses');
    expect(foldForSearch('Ça va')).toBe('ca va');
    expect(foldForSearch('办公用品 5100')).toBe('办公用品 5100');
  });
});

describe('CategoryPicker — the suspense account is never offered', () => {
  const SUSPENSE = row('susp', 'Uncategorized Expenses', '6999');
  const WITH_SUSPENSE = [...CATS.slice(0, 2), SUSPENSE, ...CATS.slice(2)];

  it('is pinned to the server constant (read from source: that module is server-only)', () => {
    const src = readFileSync(join(__dirname, '../../../lib/agentbook-chart-of-accounts.ts'), 'utf8');
    const m = src.match(/export const UNCATEGORIZED_CODE = '([^']+)'/);
    expect(m?.[1]).toBe(SUSPENSE_ACCOUNT_CODE);
  });

  it('renders no row for 6999 (by text and by id) and leaves every other category as the server sent it', async () => {
    routeFetch({ [ACCOUNTS]: () => ok(WITH_SUSPENSE) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(screen.queryByText('Uncategorized Expenses')).toBeNull();
    expect(screen.queryByText('6999')).toBeNull();
    expect(ids().slice().sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(names()).toEqual(['Advertising', 'Café & Coffee', 'Meals', 'Office Supplies', 'Travel']);
    expect(screen.getByTestId('category-status')).toHaveTextContent('5 categories');
  });

  it('a recent that points at 6999 is dropped, not resurfaced; other recents still lead', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'susp', name: 'Uncategorized Expenses' }, { id: 'c2', name: 'Meals' }]));
    routeFetch({ [ACCOUNTS]: () => ok(WITH_SUSPENSE) });
    mount();
    await screen.findAllByTestId('category-option');
    expect(ids()).toEqual(['c2', 'c3', 'c5', 'c4', 'c1']);
    expect(ids()).not.toContain('susp');
    expect(screen.queryByText('Uncategorized Expenses')).toBeNull();
  });

  it('search by name or code does not find it', async () => {
    routeFetch({ [ACCOUNTS]: () => ok(WITH_SUSPENSE) });
    mount();
    await screen.findAllByTestId('category-option');
    search('uncategor');
    expect(ids()).toEqual([]);
    expect(screen.getByText('Try a different search.')).toBeInTheDocument();
    search('6999');
    expect(ids()).toEqual([]);
    search('travel');
    expect(ids()).toEqual(['c1']);
  });

  it('a list holding only the suspense account reads as having no categories', async () => {
    routeFetch({ [ACCOUNTS]: () => ok([SUSPENSE]) });
    mount();
    await screen.findByText('No expense categories yet');
    expect(ids()).toEqual([]);
  });
});
