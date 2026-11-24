import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { SalesTaxReturnPage } from '../pages/SalesTaxReturn';
import { ReportsPage } from '../pages/Reports';

/** PR 2c — the return and the P&L footnote a tax year with unrestated legacy purchases, until it is applied. */
let restatement: Record<string, unknown>;
const AU_RET = {
  period: { start: '2026-04-01', end: '2026-06-30' }, outcome: 'refund',
  g1TotalSalesCents: 0, label1AGstOnSalesCents: 0, label1BGstOnPurchasesCents: 1000,
  netGstCents: -1000, w1TotalWagesCents: 0, w2PaygWithheldCents: 0, totalPayableCents: -1000,
};
const PNL = { basis: 'accrual', revenue: [], expenses: [], netIncomeCents: 0 };
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => ({
      success: true,
      data: url.includes('tenant-config') ? { jurisdiction: 'au', currency: 'AUD' }
        : url.includes('/restatement') ? restatement
        : url.includes('bas-return') ? AU_RET : PNL,
    }),
  })));
});
afterEach(() => vi.unstubAllGlobals());
const pending = { year: 2026, applicable: true, counts: { eligible: 3 } };
const applied = { year: 2026, applicable: true, counts: { eligible: 0 } };

describe('restatement footnote', () => {
  it('BAS shows the note while legacy rows are unrestated', async () => {
    restatement = pending;
    render(withShell(<SalesTaxReturnPage />));
    const note = await screen.findByTestId('restatement-note');
    expect(note.textContent).toBe('3 purchases from tax year 2026 still include GST/HST in expense. Restate them in Settings › Business Profile.');
  });
  it('no note once applied', async () => {
    restatement = applied;
    render(withShell(<SalesTaxReturnPage />));
    await screen.findByText('1B — GST on purchases (ITCs)');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('restatement-note')).toBeNull();
  });
  it('P&L shows the note (fr-CA renders French with U+2019)', async () => {
    restatement = { ...pending, counts: { eligible: 1 } };
    render(withShell(<ReportsPage />, 'fr-CA'));
    fireEvent.click(screen.getAllByRole('button')[0]);
    const note = await screen.findByTestId('restatement-note');
    expect(note.textContent).toBe('1 achat de l’année d’imposition 2026 inclut encore la TPS/TVH dans la dépense. Retraitez-le dans Paramètres › Profil d’entreprise.');
  });
  it('not applicable (US / non-registrant) → no note', async () => {
    restatement = { year: 2026, applicable: false, counts: { eligible: 0 } };
    render(withShell(<ReportsPage />));
    fireEvent.click(screen.getByText('Profit & Loss'));
    await waitFor(() => expect(screen.getAllByText(/Net/).length).toBeGreaterThan(0));
    expect(screen.queryByTestId('restatement-note')).toBeNull();
  });
});
