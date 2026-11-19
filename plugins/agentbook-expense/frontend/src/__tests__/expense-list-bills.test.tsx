/**
 * PR 3bc.7 — bills among the expenses on the desktop list: one row per bill
 * with a Due / Overdue / Paid badge, newest first, hidden on filtered views.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExpenseListPage } from '../pages/ExpenseList';
import { withShell } from './i18n-harness';

const exp = (id: string, vendorName: string, date: string, amountCents: number) => ({
  id, vendorName, description: vendorName, date, amountCents, currency: 'USD', categoryId: null, categoryName: null,
  isPersonal: false, paymentMethod: 'card', taxAmountCents: 0, tipAmountCents: 0, tags: '', receiptUrl: null, journalEntryId: 'j',
});
const bill = (o: Record<string, unknown>) => ({ kind: 'bill', id: 'b1', date: '2026-06-05T00:00:00.000Z', vendor: 'Acme', amountCents: 12000, status: 'due', outstandingCents: 12000, overdue: false, ...o });

let billPayload: unknown;
function installFetch() {
  global.fetch = vi.fn((url: string) => {
    const u = String(url);
    let body: unknown = { success: true, data: [] };
    if (u.includes('/purchases')) body = billPayload;
    else if (u.includes('/expenses?')) body = { success: true, data: [exp('e1', 'Staples', new Date().toISOString(), 5000), exp('e2', 'Cafe', '2020-01-01T00:00:00.000Z', 700)] };
    else if (u.includes('/category-summary')) body = { success: true, data: { categories: [] } };
    else if (u.includes('/accounts')) body = { success: true, data: [] };
    else if (u.includes('/auto-categorize/pending')) body = { success: true, data: { items: [], uncategorizedCount: 0, totalCount: 2, uncategorizedPct: 0 } };
    else if (u.includes('/tenant-config')) body = { data: { currency: 'USD', jurisdiction: 'us' } };
    return Promise.resolve({ ok: true, json: async () => body } as never);
  }) as never;
}
const mount = (locale = 'en') => render(<MemoryRouter>{withShell(<ExpenseListPage />, locale)}</MemoryRouter>);

beforeEach(() => { installFetch(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ExpenseList — bills', () => {
  it('shows each bill once with Due / Overdue / Paid badges next to the expenses', async () => {
    const now = new Date().toISOString();
    billPayload = { success: true, data: [
      bill({ id: 'b1', vendor: 'Acme', date: now }),
      bill({ id: 'b2', vendor: 'Landlord', status: 'paid', outstandingCents: 0, amountCents: 90000, date: now }),
      bill({ id: 'b3', vendor: 'Phone Co', overdue: true, date: now }),
    ] };
    mount();
    const rows = await screen.findAllByTestId('bill-row');
    expect(rows).toHaveLength(3);
    const badges = rows.map((r) => within(r).getByTestId('bill-badge').textContent);
    expect(badges).toEqual(expect.arrayContaining(['Bill · Due', 'Bill · Paid', 'Bill · Overdue']));
    expect(within(rows.find((r) => r.textContent?.includes('Landlord'))!).getByText(/900\.00/)).toBeTruthy();
    expect(screen.getAllByText('Staples').length).toBeGreaterThan(0);
  });

  it('renders French badges for fr-CA', async () => {
    billPayload = { success: true, data: [bill({ status: 'paid', outstandingCents: 0, date: new Date().toISOString() })] };
    mount('fr-CA');
    const badge = (await screen.findAllByTestId('bill-badge'))[0];
    expect(badge.textContent).toBe('Facture · Payée');
  });

  it('a failing bills request leaves the expenses untouched', async () => {
    billPayload = { success: false };
    mount();
    await screen.findAllByText('Staples');
    await waitFor(() => expect(screen.queryByTestId('bill-row')).toBeNull());
  });
});
