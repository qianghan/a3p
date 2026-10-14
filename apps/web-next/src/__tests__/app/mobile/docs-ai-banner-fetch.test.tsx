/**
 * The AI banner through a mocked global fetch — the real api.ts / api-extra.ts
 * run, so the URLs, methods and bodies the phone actually sends are asserted,
 * and the failure paths come from real HTTP answers (a 404/409, the service
 * worker's offline 503) rather than from a mocked module.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ToastHost } from '@/app/app/_kit';
import { AiBanner } from '@/app/app/docs/_components/AiBanner';
import { jsonResponse, routeFetch } from './test-utils';
import './_load-tolerance';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);

const ROW = (id: string, vendor: string, cat: string) => ({
  expenseId: id, vendorName: vendor, amountCents: 4200, date: '2026-10-01T00:00:00.000Z', description: null,
  suggestedCategoryId: `c-${cat}`, suggestedCategoryName: cat, confidence: 0.74,
});
const PENDING = '/api/v1/agentbook-core/auto-categorize/pending';
const REVIEW = '/api/v1/agentbook-core/auto-categorize/review';
const RUN = '/api/v1/agentbook-core/auto-categorize/run';
const ok = (data: unknown) => jsonResponse(200, { success: true, data });

const mount = (props: Partial<React.ComponentProps<typeof AiBanner>> = {}) => {
  const onChanged = vi.fn();
  render(<ToastHost><AiBanner noCategoryCount={0} online currency="CAD" onChanged={onChanged} {...props} /></ToastHost>);
  return { onChanged };
};

/**
 * The bulk button of a long sheet. NOT getByRole: with 100 rows (3 buttons each) the role
 * query computes an accessible name for every button and costs ~60 ms alone, several
 * seconds on a loaded runner. The label is a text node of the button itself.
 */
const acceptAll = (dialog: HTMLElement) => {
  const button = within(dialog).getByText('Accept all').closest('button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('AiBanner over real requests', () => {
  it('Accept posts the exact review body and drops the row', async () => {
    const f = routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office'), ROW('e2', 'Uber', 'Travel')], uncategorizedCount: 2 }),
      [REVIEW]: () => ok({ results: [{ expenseId: 'e1', ok: true }] }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    const call = f.mock.calls.find(([u]) => String(u) === REVIEW)!;
    expect(call[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    // Bare accept: the server applies its own stored suggestion and keeps its stale-accept guard
    // (an explicit categoryId would bypass it and could overwrite a category chosen since the list loaded).
    expect(JSON.parse(String(call[1]?.body))).toEqual({ items: [{ expenseId: 'e1', action: 'accept' }] });
  });

  it('Auto-categorize POSTs the run route, then re-reads the pending list', async () => {
    const f = routeFetch({
      [PENDING]: () => ok({ items: [], uncategorizedCount: 0 }),
      [RUN]: () => ok({ appliedCount: 3, pendingCount: 0, skippedCount: 0 }),
    });
    mount({ noCategoryCount: 3 });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-categorize' }));
    expect(await screen.findByText('Categorized: 3 · To review: 0')).toBeInTheDocument();
    expect(f.mock.calls.find(([u]) => String(u) === RUN)![1]).toMatchObject({ method: 'POST' });
    expect(f.mock.calls.filter(([u]) => String(u) === PENDING)).toHaveLength(2);
  });

  it('an HTTP 409 from the review route drops the row quietly (no raw error text)', async () => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      [REVIEW]: () => jsonResponse(409, { success: false, error: 'Expense already categorized' }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await within(dialog).findByText('No AI picks waiting.')).toBeInTheDocument();
    expect(screen.queryByText(/already categorized|Couldn’t save/)).toBeNull();
  });

  it('a 404 on the whole review request (route missing) saves nothing: the row comes back with the failure shown', async () => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      [REVIEW]: () => jsonResponse(404, { success: false, error: 'Not found' }),
    });
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await within(dialog).findByText("Couldn’t save that choice. Try again.")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a server no_suggestion for an accept drops the row with no error, and the list is re-read via onChanged', async () => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office'), ROW('e2', 'Uber', 'Travel')], uncategorizedCount: 2 }),
      [REVIEW]: () => ok({ results: [{ expenseId: 'e1', ok: false, error: 'no_suggestion' }] }),
    });
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1));
    expect(within(dialog).getByText('Uber')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t save|Not saved/)).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it('retrying an accept after a lost response is harmless: the second bare accept answers no_suggestion and the row is dropped quietly', async () => {
    let calls = 0;
    const f = routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      // First answer is lost on the wire (the server did apply it); the retry finds nothing left to accept.
      [REVIEW]: () => (++calls === 1 ? new Error('network down') : ok({ results: [{ expenseId: 'e1', ok: false, error: 'no_suggestion' }] })),
    });
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await within(dialog).findByText("Couldn’t save that choice. Try again.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await within(dialog).findByText('No AI picks waiting.')).toBeInTheDocument();
    expect(within(dialog).queryByText("Couldn’t save that choice. Try again.")).toBeNull();
    const bodies = f.mock.calls.filter(([u]) => String(u) === REVIEW).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { items: [{ expenseId: 'e1', action: 'accept' }] },
      { items: [{ expenseId: 'e1', action: 'accept' }] },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("the service worker's offline 503 is a failure, not a resolution: the row comes back with the failure shown", async () => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      [REVIEW]: () => jsonResponse(503, { success: false, error: 'offline' }, { 'X-Agentbook-Offline': '1' }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await screen.findByText("Couldn’t save that choice. Try again.")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('review-row')).toHaveLength(1);
  });

  it('sends 51 accepts as two requests of at most 50 (the route limit)', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ROW(`e${i}`, `V${i}`, 'Office'));
    const f = routeFetch({
      [PENDING]: () => ok({ items: rows, uncategorizedCount: 51 }),
      [REVIEW]: (_u, init) => ok({ results: (JSON.parse(String(init?.body)).items as Array<{ expenseId: string }>).map((i) => ({ expenseId: i.expenseId, ok: true })) }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(acceptAll(dialog));
    await within(dialog).findByText('No AI picks waiting.');
    const sizes = f.mock.calls.filter(([u]) => String(u) === REVIEW).map(([, init]) => JSON.parse(String(init?.body)).items.length);
    expect(sizes).toEqual([50, 1]);
  });

  it('101 accepts: chunk 1 saves, chunk 2 answers 500, processing STOPS (chunk 3 is never sent); only the unsaved rows come back', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ROW(`e${i}`, `V${i}`, 'Office'));
    let n = 0;
    const f = routeFetch({
      [PENDING]: () => ok({ items: rows, uncategorizedCount: 101 }),
      [REVIEW]: (_u, init) => {
        n += 1;
        if (n > 1) return jsonResponse(500, { success: false, error: 'boom' });
        return ok({ results: (JSON.parse(String(init?.body)).items as Array<{ expenseId: string }>).map((i) => ({ expenseId: i.expenseId, ok: true })) });
      },
    });
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(acceptAll(dialog));
    expect(await within(dialog).findByText('Not saved: 51')).toBeInTheDocument();
    const sent = f.mock.calls.filter(([u]) => String(u) === REVIEW).map(([, init]) => (JSON.parse(String(init?.body)).items as unknown[]).length);
    expect(sent).toEqual([50, 50]); // no third request after the failure
    const left = within(dialog).getAllByTestId('review-row');
    expect(left).toHaveLength(51); // chunk 2 (50) + the never-sent chunk 3 (1)
    expect(within(dialog).queryByText('V0')).toBeNull(); // chunk 1 stays saved
    expect(within(dialog).queryByText('V49')).toBeNull();
    expect(within(dialog).getByText('V50')).toBeInTheDocument();
    expect(within(dialog).getByText('V100')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('offline, no pending GET is made and no review write can be sent', async () => {
    const f = routeFetch({ [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }) });
    mount({ noCategoryCount: 1, online: false });
    await screen.findByText('Without a category: 1');
    expect(f).not.toHaveBeenCalled();
  });
});
