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
    expect(JSON.parse(String(call[1]?.body))).toEqual({ items: [{ expenseId: 'e1', action: 'accept', categoryId: 'c-Office' }] });
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

  it.each([404, 409])('an HTTP %i from the review route drops the row quietly (no raw error text)', async (status) => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      [REVIEW]: () => jsonResponse(status, { success: false, error: 'Expense already categorized' }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await within(dialog).findByText('No AI picks waiting.')).toBeInTheDocument();
    expect(screen.queryByText(/already categorized|Couldn't save/)).toBeNull();
  });

  it("the service worker's offline 503 is a failure, not a resolution: the row comes back with a toast", async () => {
    routeFetch({
      [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }),
      [REVIEW]: () => jsonResponse(503, { success: false, error: 'offline' }, { 'X-Agentbook-Offline': '1' }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review AI picks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review AI picks' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Office for Staples' }));
    expect(await screen.findByText("Couldn't save that choice. Try again.")).toBeInTheDocument();
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept all' }));
    await within(dialog).findByText('No AI picks waiting.');
    const sizes = f.mock.calls.filter(([u]) => String(u) === REVIEW).map(([, init]) => JSON.parse(String(init?.body)).items.length);
    expect(sizes).toEqual([50, 1]);
  });

  it('offline, no pending GET is made and no review write can be sent', async () => {
    const f = routeFetch({ [PENDING]: () => ok({ items: [ROW('e1', 'Staples', 'Office')], uncategorizedCount: 1 }) });
    mount({ noCategoryCount: 1, online: false });
    await screen.findByText('Without a category: 1');
    expect(f).not.toHaveBeenCalled();
  });
});
