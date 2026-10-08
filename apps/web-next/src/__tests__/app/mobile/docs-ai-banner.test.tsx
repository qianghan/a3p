import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ToastHost } from '@/app/app/_kit';
import { AiBanner, LAST_AUTOCAT_KEY } from '@/app/app/docs/_components/AiBanner';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);
const api = vi.hoisted(() => ({ runAutoCategorize: vi.fn(), reviewSuggestions: vi.fn() }));
vi.mock('@/app/app/_lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const extra = vi.hoisted(() => ({ getPendingSuggestions: vi.fn() }));
vi.mock('@/app/app/_lib/api-extra', async (orig) => ({ ...(await orig<object>()), ...extra }));

const S = (id: string, vendor: string, cat: string) => ({
  expenseId: id, vendorName: vendor, amountCents: 4200, date: '2026-10-01', description: null,
  suggestedCategoryId: `c-${cat}`, suggestedCategoryName: cat, confidence: 0.74,
});
const renderBanner = (props: Partial<React.ComponentProps<typeof AiBanner>> = {}) => {
  const onChanged = vi.fn();
  const utils = render(<ToastHost><AiBanner noCategoryCount={0} online currency="CAD" onChanged={onChanged} {...props} /></ToastHost>);
  return { onChanged, ...utils };
};

beforeEach(() => {
  localStorage.clear();
  api.runAutoCategorize.mockReset();
  api.reviewSuggestions.mockReset();
  extra.getPendingSuggestions.mockReset();
  extra.getPendingSuggestions.mockResolvedValue({ items: [], uncategorizedCount: 0 });
});

describe('AiBanner text', () => {
  it('is hidden when there is nothing for AI to do', async () => {
    renderBanner();
    await waitFor(() => expect(extra.getPendingSuggestions).toHaveBeenCalled());
    expect(screen.queryByText(/AI picks waiting|Without a category|AI categorized/)).toBeNull();
  });
  it('shows pending picks when no run is recorded on this device', async () => {
    extra.getPendingSuggestions.mockResolvedValue({ items: [S('e1', 'Staples', 'Office'), S('e2', 'Uber', 'Travel')], uncategorizedCount: 2 });
    renderBanner();
    expect(await screen.findByText('AI picks waiting: 2')).toBeInTheDocument();
  });
  it('shows "AI categorized N · M need you" after a recent run', async () => {
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify({ appliedCount: 5, pendingCount: 1, skippedCount: 0, at: Date.now() }));
    extra.getPendingSuggestions.mockResolvedValue({ items: [S('e1', 'Staples', 'Office')], uncategorizedCount: 1 });
    renderBanner();
    expect(await screen.findByText('AI categorized: 5 · Need you: 1')).toBeInTheDocument();
  });
  it('ignores a run older than 24h', async () => {
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify({ appliedCount: 5, pendingCount: 0, skippedCount: 0, at: Date.now() - 25 * 3600_000 }));
    renderBanner({ noCategoryCount: 3 });
    expect(await screen.findByText('Without a category: 3')).toBeInTheDocument();
  });
});

describe('Auto-categorize', () => {
  it('runs, shows the real counts, records the run and reloads the list', async () => {
    api.runAutoCategorize.mockResolvedValue({ appliedCount: 4, pendingCount: 2, skippedCount: 1 });
    const { onChanged } = renderBanner({ noCategoryCount: 7 });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    expect(await screen.findByText('Categorized: 4 · To review: 2')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LAST_AUTOCAT_KEY)!)).toMatchObject({ appliedCount: 4, pendingCount: 2 });
    expect(extra.getPendingSuggestions).toHaveBeenCalledTimes(2);
  });
  it('says so truthfully when the run found nothing (server 20h dedupe returns zeros)', async () => {
    api.runAutoCategorize.mockResolvedValue({ appliedCount: 0, pendingCount: 0, skippedCount: 0 });
    renderBanner({ noCategoryCount: 2 });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    expect(await screen.findByText('Nothing new to categorize right now')).toBeInTheDocument();
  });
  it('a zero answer from the server dedupe does not overwrite the last real run', async () => {
    const real = { appliedCount: 5, pendingCount: 0, skippedCount: 0, at: Date.now() - 3600_000 };
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify(real));
    api.runAutoCategorize.mockResolvedValue({ appliedCount: 0, pendingCount: 0, skippedCount: 0 });
    renderBanner({ noCategoryCount: 2 });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    await screen.findByText('Nothing new to categorize right now');
    expect(JSON.parse(localStorage.getItem(LAST_AUTOCAT_KEY)!)).toEqual(real);
    expect(screen.getByText('AI categorized: 5 · Need you: 0')).toBeInTheDocument();
  });
  it('shows an error toast on failure and re-enables the button', async () => {
    api.runAutoCategorize.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    renderBanner({ noCategoryCount: 2 });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    expect(await screen.findByText('Auto-categorize failed. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-categorize' })).toBeEnabled();
  });
  it('is disabled offline and says why', async () => {
    renderBanner({ noCategoryCount: 2, online: false });
    expect(await screen.findByRole('button', { name: 'Auto-categorize' })).toBeDisabled();
    expect(screen.getByText("You're offline. Changes are disabled until you reconnect.")).toBeInTheDocument();
  });
});

describe('Review AI picks sheet', () => {
  beforeEach(() => {
    extra.getPendingSuggestions.mockResolvedValue({ items: [S('e1', 'Staples', 'Office'), S('e2', 'Uber', 'Travel')], uncategorizedCount: 2 });
  });
  it('accepts one row with its suggested category and removes it', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }]);
    const { onChanged } = renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(2);
    expect(within(dialog).getAllByText('74% sure')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(api.reviewSuggestions).toHaveBeenCalledWith([{ expenseId: 'e1', action: 'accept', categoryId: 'c-Office' }]);
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalled();
  });
  it('shows each amount in the tenant currency, or a dash while the currency is unknown (never a guessed $)', async () => {
    const { unmount } = renderBanner({ currency: 'CAD' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    expect(within(dialog).getAllByText('CA$42')).toHaveLength(2);
    expect(dialog.querySelector('[data-money="CAD"]')).not.toBeNull();
    unmount();

    renderBanner({ currency: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const d2 = await screen.findByRole('dialog', { name: 'Review AI picks' });
    expect(d2.textContent).not.toMatch(/\$|42|NaN/);
    expect(d2.querySelectorAll('[data-money="none"]')).toHaveLength(2);
  });
  it('rejects one row', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e2', ok: true }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Travel for Uber' }));
    expect(api.reviewSuggestions).toHaveBeenCalledWith([{ expenseId: 'e2', action: 'reject' }]);
  });
  it('Accept all sends every row; failed rows come back with a toast', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }, { expenseId: 'e2', ok: false, error: 'gone' }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept all' }));
    expect(api.reviewSuggestions).toHaveBeenCalledWith([
      { expenseId: 'e1', action: 'accept', categoryId: 'c-Office' },
      { expenseId: 'e2', action: 'accept', categoryId: 'c-Travel' },
    ]);
    expect(await screen.findByText('Not saved: 1')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Uber')).toBeInTheDocument();
  });
  it('restores the row and toasts when the request itself fails (optimistic rollback)', async () => {
    api.reviewSuggestions.mockRejectedValue(new Error('network'));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await screen.findByText("Couldn't save that choice. Try again.")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(2);
  });
  it('keeps every action touch-sized', async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    for (const b of within(dialog).getAllByRole('button')) {
      expect(parseFloat(b.style.minHeight), b.textContent ?? '').toBeGreaterThanOrEqual(44);
    }
  });
});

describe('already-resolved rows (stale offline cache / a second device)', () => {
  beforeEach(() => {
    extra.getPendingSuggestions.mockResolvedValue({ items: [S('e1', 'Staples', 'Office'), S('e2', 'Uber', 'Travel')], uncategorizedCount: 2 });
  });
  it.each(['not_found', 'no_suggestion'])('drops a row the server answers "%s" for, with no error toast', async (error) => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: false, error }]);
    const { onChanged } = renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Uber')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't save that choice. Try again.")).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
  it.each([404, 409])('drops the row when the request itself answers HTTP %i, instead of a raw error', async (status) => {
    api.reviewSuggestions.mockRejectedValue(Object.assign(new Error('HTTP error'), { status }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject Travel for Uber' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Staples')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't save that choice. Try again.")).toBeNull();
    expect(screen.queryByText('HTTP error')).toBeNull();
  });
  it('a 500 is a real failure: row restored with a toast', async () => {
    api.reviewSuggestions.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject Travel for Uber' }));
    expect(await screen.findByText("Couldn't save that choice. Try again.")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(2);
  });
});

describe('ordering', () => {
  it('a slow pending response that started before a row was resolved cannot bring that row back', async () => {
    const two = { items: [S('e1', 'Staples', 'Office'), S('e2', 'Uber', 'Travel')], uncategorizedCount: 2 };
    let release!: (v: typeof two) => void;
    extra.getPendingSuggestions
      .mockResolvedValueOnce(two)
      .mockImplementationOnce(() => new Promise((res) => { release = res; }));
    api.runAutoCategorize.mockResolvedValue({ appliedCount: 1, pendingCount: 2, skippedCount: 0 });
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));   // second load now in flight
    await waitFor(() => expect(extra.getPendingSuggestions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    release(two);                                                                       // the old answer still lists e1
    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto-categorize' })).toBeEnabled());
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1);
    expect(within(dialog).queryByText('Staples')).toBeNull();
  });
});

describe('offline', () => {
  const two = { items: [S('e1', 'Staples', 'Office'), S('e2', 'Uber', 'Travel')], uncategorizedCount: 2 };
  it('does not ask for pending picks while offline (the service worker could answer from a stale cache)', async () => {
    extra.getPendingSuggestions.mockResolvedValue(two);
    renderBanner({ noCategoryCount: 2, online: false });
    await screen.findByText('Without a category: 2');
    expect(extra.getPendingSuggestions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review AI picks' })).toBeDisabled();
  });
  it('loads them once the connection returns', async () => {
    extra.getPendingSuggestions.mockResolvedValue(two);
    const onChanged = vi.fn();
    const ui = (online: boolean) => <ToastHost><AiBanner noCategoryCount={2} online={online} currency="CAD" onChanged={onChanged} /></ToastHost>;
    const { rerender } = render(ui(false));
    await screen.findByText('Without a category: 2');
    rerender(ui(true));
    expect(await screen.findByText('AI picks waiting: 2')).toBeInTheDocument();
    expect(extra.getPendingSuggestions).toHaveBeenCalledTimes(1);
  });
  it('an open sheet disables Accept / Reject / Accept all the moment the device goes offline, and sends nothing', async () => {
    extra.getPendingSuggestions.mockResolvedValue(two);
    const ui = (online: boolean) => <ToastHost><AiBanner noCategoryCount={0} online={online} currency="CAD" onChanged={() => {}} /></ToastHost>;
    const { rerender } = render(ui(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    rerender(ui(false));
    for (const name of ['Accept Office for Staples', 'Reject Office for Staples', 'Accept all']) {
      const b = within(dialog).queryByRole('button', { name });
      if (b) { expect(b).toBeDisabled(); fireEvent.click(b); }
    }
    expect(within(dialog).getByRole('button', { name: 'Accept Office for Staples' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Reject Travel for Uber' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Accept all' })).toBeDisabled();
    expect(within(dialog).getByText("You're offline. Changes are disabled until you reconnect.")).toBeInTheDocument();
    expect(api.reviewSuggestions).not.toHaveBeenCalled();
  });
});

describe('sign-out while mounted', () => {
  it('drops the previous user’s run and picks', async () => {
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify({ appliedCount: 5, pendingCount: 1, skippedCount: 0, at: Date.now() }));
    extra.getPendingSuggestions.mockResolvedValue({ items: [S('e1', 'Staples', 'Office')], uncategorizedCount: 1 });
    renderBanner();
    await screen.findByText('AI categorized: 5 · Need you: 1');
    window.dispatchEvent(new CustomEvent('ab:mobile:cleared', { detail: { reason: 'session' } }));
    await waitFor(() => expect(screen.queryByText(/AI categorized|AI picks waiting/)).toBeNull());
  });
});
