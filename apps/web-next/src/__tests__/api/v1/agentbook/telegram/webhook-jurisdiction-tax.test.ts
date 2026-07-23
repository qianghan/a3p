import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { calcJurisdictionTax, renderTaxPackageStepResult } from '@/app/api/v1/agentbook/telegram/webhook/route';

/**
 * PR-2 (C3/H5): the Telegram fallback agent and tax-package renderer must use
 * per-jurisdiction tax math and the correct business-tax form name, not the
 * old hardcoded US SE/FICA math + "Schedule C" for every non-CA tenant.
 */
describe('calcJurisdictionTax (C3 — fallback tax estimate)', () => {
  const NET = 80_000_00; // $80k net self-employment income
  const YEAR = 2026;

  it('computes non-zero AU tax via the AU providers (not US math, not $0)', () => {
    const au = calcJurisdictionTax(NET, 'au', YEAR);
    expect(au.incomeCents).toBeGreaterThan(0);
    expect(au.totalCents).toBeGreaterThan(0);
  });

  it('produces materially different totals for AU vs US at the same net income', () => {
    const au = calcJurisdictionTax(NET, 'au', YEAR);
    const us = calcJurisdictionTax(NET, 'us', YEAR);
    // The old bug applied identical US math to AU; correct per-jurisdiction
    // logic must diverge (AU has no SE/FICA tax; US does).
    expect(au.totalCents).not.toBe(us.totalCents);
  });

  it('returns all-zero for non-positive net income', () => {
    expect(calcJurisdictionTax(0, 'us', YEAR)).toEqual({ seCents: 0, incomeCents: 0, totalCents: 0 });
    expect(calcJurisdictionTax(-500, 'ca', YEAR)).toEqual({ seCents: 0, incomeCents: 0, totalCents: 0 });
  });

  it('CA produces a non-zero total from the CA providers', () => {
    const ca = calcJurisdictionTax(NET, 'ca', YEAR);
    expect(ca.totalCents).toBeGreaterThan(0);
  });
});

describe('renderTaxPackageStepResult (H5 — form name per jurisdiction)', () => {
  const base = {
    kind: 'tax_package' as const,
    packageId: 'pkg1',
    year: 2026,
    pdfUrl: 'https://x/p.pdf',
    receiptsZipUrl: null,
    csvUrls: { pnl: 'https://x/pnl.csv', mileage: 'https://x/m.csv', deductions: 'https://x/d.csv' },
    summary: { expenseCount: 3, deductionsCents: 100000, mileageDeductionCents: 5000, arTotalCents: 0, pnlByLine: {}, period: { start: '2026-01-01', end: '2026-12-31' } },
  };

  it('titles an AU package with the AU business schedule, not the US Schedule C', () => {
    const { html } = renderTaxPackageStepResult({ ...base, jurisdiction: 'au' });
    expect(html).toContain('business schedule');
    expect(html).not.toContain('Schedule C');
  });

  it('uses T2125 for CA and Schedule C for US', () => {
    expect(renderTaxPackageStepResult({ ...base, jurisdiction: 'ca' }).html).toContain('T2125');
    expect(renderTaxPackageStepResult({ ...base, jurisdiction: 'us' }).html).toContain('Schedule C');
  });
});
