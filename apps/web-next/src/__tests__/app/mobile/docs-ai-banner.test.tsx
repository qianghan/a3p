import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ToastHost } from '@/app/app/_kit';
import { AiBanner, LAST_AUTOCAT_KEY } from '@/app/app/docs/_components/AiBanner';
import { claimMobileSnapshots, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import './_load-tolerance';

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

describe('last-run storage', () => {
  it('lives under the ab:mobile: prefix (asserted as a literal, not via the constant) so sign-out and claim purge it', () => {
    expect(LAST_AUTOCAT_KEY.startsWith('ab:mobile:')).toBe(true);
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify({ appliedCount: 5, pendingCount: 0, skippedCount: 0, at: Date.now() }));
    clearMobileSnapshots();
    expect(localStorage.getItem(LAST_AUTOCAT_KEY)).toBeNull();
    localStorage.setItem(LAST_AUTOCAT_KEY, '{}');
    localStorage.setItem('ab:mobile-owner', 'someone-else');
    claimMobileSnapshots('another-user'); // a different user signs in: the previous user's run goes
    expect(localStorage.getItem(LAST_AUTOCAT_KEY)).toBeNull();
  });
  it('ignores a run stamped in the future (clock set back) instead of treating it as recent forever', async () => {
    localStorage.setItem(LAST_AUTOCAT_KEY, JSON.stringify({ appliedCount: 5, pendingCount: 0, skippedCount: 0, at: Date.now() + 3600_000 }));
    renderBanner({ noCategoryCount: 3 });
    expect(await screen.findByText('Without a category: 3')).toBeInTheDocument();
    expect(screen.queryByText(/AI categorized/)).toBeNull();
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
    const btn = screen.getByRole('button', { name: 'Auto-categorize' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('aria-busy');
  });
  it('is aria-disabled offline (not disabled), ignores taps, and says why', async () => {
    renderBanner({ noCategoryCount: 2, online: false });
    const btn = await screen.findByRole('button', { name: 'Auto-categorize' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(api.runAutoCategorize).not.toHaveBeenCalled();
    expect(screen.getByText("You’re offline. Changes are disabled until you reconnect.")).toBeInTheDocument();
  });
  it('keeps keyboard focus on the button while a run is in flight, and a second tap sends nothing', async () => {
    let finish!: (v: { appliedCount: number; pendingCount: number; skippedCount: number }) => void;
    api.runAutoCategorize.mockImplementation(() => new Promise((res) => { finish = res; }));
    renderBanner({ noCategoryCount: 2 });
    const btn = await screen.findByRole('button', { name: 'Auto-categorize' });
    btn.focus();
    fireEvent.click(btn);
    const busy = await screen.findByRole('button', { name: 'Categorizing…' });
    expect(busy).toBe(btn);
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).not.toBeDisabled();
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(api.runAutoCategorize).toHaveBeenCalledTimes(1);
    finish({ appliedCount: 1, pendingCount: 0, skippedCount: 0 });
    await screen.findByText('Categorized: 1 · To review: 0');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Auto-categorize' }));
  });
  it('Review AI picks is aria-disabled with nothing to review, and a tap does not open the sheet', async () => {
    renderBanner({ noCategoryCount: 2 });
    const btn = await screen.findByRole('button', { name: 'Review AI picks' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
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
    // Bare accept: no categoryId, so the server applies its own stored suggestion and keeps its stale-accept guard.
    expect(api.reviewSuggestions).toHaveBeenCalledWith([{ expenseId: 'e1', action: 'accept' }]);
    expect(api.reviewSuggestions.mock.calls[0][0][0]).not.toHaveProperty('categoryId');
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalled();
  });
  it('announces the result inside the dialog and moves focus to that status line instead of <body>', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    const accept = within(dialog).getByRole('button', { name: 'Accept Office for Staples' });
    accept.focus();
    fireEvent.click(accept);
    const status = await within(dialog).findByText('1 AI pick resolved');
    expect(status).toHaveAttribute('role', 'status');
    expect(dialog.contains(status)).toBe(true);
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(document.activeElement).toBe(status);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  it('uses the plural form for several resolved rows', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }, { expenseId: 'e2', ok: true }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept all' }));
    expect(await within(dialog).findByText('2 AI picks resolved')).toHaveAttribute('role', 'status');
  });
  it('announces a failure inside the dialog (where a modal-inert toast could not be heard) and keeps focus in it', async () => {
    api.reviewSuggestions.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    const accept = within(dialog).getByRole('button', { name: 'Accept Office for Staples' });
    accept.focus();
    fireEvent.click(accept);
    const status = await within(dialog).findByText("Couldn’t save that choice. Try again.");
    expect(status).toHaveAttribute('role', 'status');
    expect(dialog.contains(status)).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(2);
  });
  it('keeps focus on the pressed control, and ignores a second tap, while a request is in flight', async () => {
    let finish!: (v: Array<{ expenseId: string; ok: boolean }>) => void;
    api.reviewSuggestions.mockImplementation(() => new Promise((res) => { finish = res; }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    const other = within(dialog).getByRole('button', { name: 'Accept Travel for Uber' });
    expect(other).toHaveAttribute('aria-disabled', 'true');
    expect(other).toHaveAttribute('aria-busy', 'true');
    expect(other).not.toBeDisabled();
    other.focus();
    fireEvent.click(other);
    expect(api.reviewSuggestions).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(other);
    finish([{ expenseId: 'e1', ok: true }]);
    await within(dialog).findByText('1 AI pick resolved');
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
  it('Accept all sends every row; failed rows come back with a status line', async () => {
    api.reviewSuggestions.mockResolvedValue([{ expenseId: 'e1', ok: true }, { expenseId: 'e2', ok: false, error: 'gone' }]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept all' }));
    expect(api.reviewSuggestions).toHaveBeenCalledWith([
      { expenseId: 'e1', action: 'accept' },
      { expenseId: 'e2', action: 'accept' },
    ]);
    expect(await screen.findByText('Not saved: 1')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Uber')).toBeInTheDocument();
  });
  it('restores the row and says so when the request itself fails (optimistic rollback)', async () => {
    api.reviewSuggestions.mockRejectedValue(new Error('network'));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await screen.findByText("Couldn’t save that choice. Try again.")).toBeInTheDocument();
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
    expect(screen.queryByText("Couldn’t save that choice. Try again.")).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
  it('drops the row when the request itself answers HTTP 409, instead of a raw error', async () => {
    api.reviewSuggestions.mockRejectedValue(Object.assign(new Error('HTTP error'), { status: 409 }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject Travel for Uber' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Staples')).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t save that choice. Try again.")).toBeNull();
    expect(screen.queryByText('HTTP error')).toBeNull();
  });
  it.each([404, 500])('HTTP %i on the whole request is a real failure (nothing was saved): row restored, failure shown', async (status) => {
    api.reviewSuggestions.mockRejectedValue(Object.assign(new Error('boom'), { status }));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject Travel for Uber' }));
    expect(await screen.findByText("Couldn’t save that choice. Try again.")).toBeInTheDocument();
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
    const review = screen.getByRole('button', { name: 'Review AI picks' });
    expect(review).toHaveAttribute('aria-disabled', 'true');
    expect(review).not.toBeDisabled();
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
  it('an open sheet aria-disables Accept / Reject / Accept all the moment the device goes offline, and sends nothing', async () => {
    extra.getPendingSuggestions.mockResolvedValue(two);
    const ui = (online: boolean) => <ToastHost><AiBanner noCategoryCount={0} online={online} currency="CAD" onChanged={() => {}} /></ToastHost>;
    const { rerender } = render(ui(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    const focused = within(dialog).getByRole('button', { name: 'Accept all' });
    focused.focus();
    rerender(ui(false));
    expect(document.activeElement).toBe(focused);
    for (const name of ['Accept Office for Staples', 'Reject Office for Staples', 'Accept all']) {
      const b = within(dialog).queryByRole('button', { name });
      if (b) { expect(b).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(b); }
    }
    for (const name of ['Accept Office for Staples', 'Reject Travel for Uber', 'Accept all']) {
      const b = within(dialog).getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled(); // focus must stay on it, not fall to <body>
    }
    expect(within(dialog).getByText("You’re offline. Changes are disabled until you reconnect.")).toBeInTheDocument();
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
