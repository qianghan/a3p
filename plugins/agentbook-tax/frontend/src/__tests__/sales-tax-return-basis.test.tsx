import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { SalesTaxReturnPage } from '../pages/SalesTaxReturn';

/** Review I1(b) + M6: the return screen shows the cash-basis refusal and that sales are invoice-dated. */
let ret: Record<string, unknown>;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => ({ success: true, data: url.includes('tenant-config') ? { jurisdiction: 'au', currency: 'AUD' } : ret }),
  })));
});
afterEach(() => vi.unstubAllGlobals());
const AU = {
  period: { start: '2026-07-01', end: '2026-09-30' }, outcome: 'refund', g1TotalSalesCents: 0, label1AGstOnSalesCents: 0,
  label1BGstOnPurchasesCents: 0, g10CapitalPurchasesCents: 0, g11NonCapitalPurchasesCents: 0, netGstCents: 0,
  w1TotalWagesCents: 0, w2PaygWithheldCents: 0, totalPayableCents: 0, salesBasis: 'invoice_date',
};

describe('SalesTaxReturn basis notes', () => {
  it('cash basis: footnote says sales are by invoice date', async () => {
    ret = { ...AU, gstReportingBasis: 'cash' };
    render(withShell(<SalesTaxReturnPage />));
    const n = await screen.findByTestId('return-sales-basis');
    expect(n.textContent).toBe('Cash basis: purchases are counted when paid. Sales are reported by invoice date.');
  });
  it('fr-CA footnote', async () => {
    ret = { ...AU, gstReportingBasis: 'cash' };
    render(withShell(<SalesTaxReturnPage />, 'fr-CA'));
    expect((await screen.findByTestId('return-sales-basis')).textContent).toMatch(/date de facture/);
  });
  it('accrual: no footnote; cashBasisDisabled → banner', async () => {
    ret = { ...AU, gstReportingBasis: 'accrual', cashBasisDisabled: { reason: 'open_at_entry_bills', openAtEntryBillCount: 1 } };
    render(withShell(<SalesTaxReturnPage />));
    const b = await screen.findByTestId('return-cash-basis-disabled');
    expect(b.textContent).toBe('Cash basis is unavailable while 1 bill is still open. Showing accrual basis instead.');
    await waitFor(() => expect(screen.queryByTestId('return-sales-basis')).toBeNull());
  });
});
