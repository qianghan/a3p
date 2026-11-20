import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { SalesTaxReturnPage } from '../pages/SalesTaxReturn';

/** PR 2b.8 — the return view shows BAS G10/G11 and the CA QST ITR line. */
let cfg: Record<string, unknown>;
let ret: Record<string, unknown>;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => ({ success: true, data: url.includes('tenant-config') ? cfg : ret }),
  })));
});
afterEach(() => vi.unstubAllGlobals());

const AU_RET = {
  period: { start: '2026-04-01', end: '2026-06-30' }, outcome: 'refund',
  g1TotalSalesCents: 0, label1AGstOnSalesCents: 0, label1BGstOnPurchasesCents: 1000,
  g10CapitalPurchasesCents: 220000, g11NonCapitalPurchasesCents: 11000,
  netGstCents: -1000, w1TotalWagesCents: 0, w2PaygWithheldCents: 0, totalPayableCents: -1000,
};
const CA_RET = {
  period: { start: '2026-04-01', end: '2026-06-30' }, outcome: 'refund',
  line101TotalSalesCents: 0, line105GstHstCollectedCents: 0, line108ItcCents: 500, line109NetTaxCents: -500, qstItrCents: 998,
};
const rowText = (testid: string) => screen.getByTestId(testid).textContent;

describe('SalesTaxReturn lines', () => {
  it('AU BAS shows G10 and G11 with their amounts', async () => {
    cfg = { jurisdiction: 'au', currency: 'AUD' }; ret = AU_RET;
    render(withShell(<SalesTaxReturnPage />));
    await waitFor(() => expect(screen.getByTestId('return-line-g10')).toBeTruthy());
    expect(rowText('return-line-g10')).toContain('G10 — Capital purchases');
    expect(rowText('return-line-g10')).toContain('2,200.00');
    expect(rowText('return-line-g11')).toContain('G11 — Non-capital purchases');
    expect(rowText('return-line-g11')).toContain('110.00');
  });

  it('AU BAS labels translate (fr-CA)', async () => {
    cfg = { jurisdiction: 'au', currency: 'AUD' }; ret = AU_RET;
    render(withShell(<SalesTaxReturnPage />, 'fr-CA'));
    await waitFor(() => expect(screen.getByTestId('return-line-g10')).toBeTruthy());
    expect(rowText('return-line-g10')).toContain('G10 — Achats d’immobilisations');
  });

  it('PR 4d: AU BAS with wages shows the pay-date footer (en, fr-CA, zh-CN); none without wages', async () => {
    cfg = { jurisdiction: 'au', currency: 'AUD' }; ret = { ...AU_RET, w1TotalWagesCents: 100000, w2PaygWithheldCents: 20000 };
    const expected: Record<string, string> = {
      en: 'W1 and W2 count wages by pay date',
      'fr-CA': 'W1 et W2 comptent les salaires selon la date de paie',
      'zh-CN': 'W1 和 W2 按发薪日期计入工资',
    };
    for (const [loc, text] of Object.entries(expected)) {
      const { unmount } = render(withShell(<SalesTaxReturnPage />, loc as 'en'));
      await waitFor(() => expect(screen.getByTestId('return-wages-basis')).toBeTruthy());
      expect(screen.getByTestId('return-wages-basis').textContent).toContain(text);
      unmount();
    }
    ret = AU_RET;
    render(withShell(<SalesTaxReturnPage />));
    await waitFor(() => expect(screen.getByTestId('return-line-g10')).toBeTruthy());
    expect(screen.queryByTestId('return-wages-basis')).toBeNull();
  });

  it('CA return shows the QST ITR line when present', async () => {
    cfg = { jurisdiction: 'ca', currency: 'CAD' }; ret = CA_RET;
    render(withShell(<SalesTaxReturnPage />));
    await waitFor(() => expect(screen.getByTestId('return-line-qst-itr')).toBeTruthy());
    expect(rowText('return-line-qst-itr')).toContain('QST input tax refunds (ITRs)');
    expect(rowText('return-line-qst-itr')).toContain('9.98');
  });

  it('CA return omits the QST ITR line when zero', async () => {
    cfg = { jurisdiction: 'ca', currency: 'CAD' }; ret = { ...CA_RET, qstItrCents: 0 };
    render(withShell(<SalesTaxReturnPage />));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByTestId('return-line-qst-itr')).toBeNull();
  });
});
