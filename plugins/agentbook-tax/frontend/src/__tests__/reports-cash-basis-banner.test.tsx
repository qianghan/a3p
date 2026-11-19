import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { ReportsPage } from '../pages/Reports';

/** PR 3bc.8 — the P&L shows why cash basis was refused. */
let pnl: Record<string, unknown>;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: pnl }) })));
});
afterEach(() => vi.unstubAllGlobals());

const BASE = { basis: 'accrual', revenue: [], expenses: [], netIncomeCents: 0 };

describe('Reports cash-basis banner', () => {
  it('shows the localized banner with the bill count when the API disabled cash basis', async () => {
    pnl = { ...BASE, cashBasisDisabled: { reason: 'open_at_entry_bills', openAtEntryBillCount: 3 } };
    render(withShell(<ReportsPage />));
    fireEvent.click(screen.getByText('Profit & Loss'));
    const banner = await screen.findByTestId('cash-basis-disabled');
    expect(banner.textContent).toBe('Cash basis is unavailable while 3 bills are still open. Showing accrual basis instead.');
  });
  it('fr-CA renders the French banner', async () => {
    pnl = { ...BASE, cashBasisDisabled: { reason: 'open_at_entry_bills', openAtEntryBillCount: 2 } };
    render(withShell(<ReportsPage />, 'fr-CA'));
    fireEvent.click(screen.getByText('Profit & Loss'));
    const banner = await screen.findByTestId('cash-basis-disabled');
    expect(banner.textContent).toContain('2');
    expect(banner.textContent).toMatch(/comptabilité de caisse/);
    expect(banner.textContent).toContain('’');
  });
  it('no banner without the flag', async () => {
    pnl = BASE;
    render(withShell(<ReportsPage />));
    fireEvent.click(screen.getByText('Profit & Loss'));
    await waitFor(() => expect(screen.getAllByText(/Net/).length).toBeGreaterThan(0));
    expect(screen.queryByTestId('cash-basis-disabled')).toBeNull();
  });
});
