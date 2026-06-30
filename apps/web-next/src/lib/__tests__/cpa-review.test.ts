import { describe, it, expect } from 'vitest';
import { runCpaReview, type ReviewMetrics } from '../cpa-review';

const clean: ReviewMetrics = {
  jurisdiction: 'us',
  uncategorizedExpenseCount: 0,
  missingReceiptCount: 0,
  overdueBillCount: 0,
  overdueBillCents: 0,
  effectiveTaxRate: 20,
  netIncomeCents: 80_000_00,
  estimatedTaxCents: 16_000_00,
  cashOnHandCents: 40_000_00,
  quarterlyTaxDueSoon: false,
};

describe('CPA review engine', () => {
  it('clean books → single info finding and a high score', () => {
    const r = runCpaReview(clean);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].category).toBe('clean');
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('flags uncategorized expenses as auto-fixable', () => {
    const r = runCpaReview({ ...clean, uncategorizedExpenseCount: 12 });
    const f = r.findings.find((x) => x.category === 'bookkeeping');
    expect(f).toBeTruthy();
    expect(f!.autoFixable).toBe(true);
    expect(f!.severity).toBe('warning');
  });

  it('critical findings lower the score more than info', () => {
    const withCritical = runCpaReview({ ...clean, quarterlyTaxDueSoon: true });
    expect(withCritical.score).toBeLessThan(runCpaReview(clean).score);
    expect(withCritical.findings.some((f) => f.severity === 'critical')).toBe(true);
  });

  it('flags cash below estimated tax as critical cash-flow', () => {
    const r = runCpaReview({ ...clean, cashOnHandCents: 1_000_00, estimatedTaxCents: 16_000_00 });
    const f = r.findings.find((x) => x.category === 'cash-flow');
    expect(f?.severity).toBe('critical');
  });

  it('uses the jurisdiction tax form name in the detail', () => {
    const ca = runCpaReview({ ...clean, jurisdiction: 'ca', uncategorizedExpenseCount: 3 });
    expect(ca.findings.find((f) => f.category === 'bookkeeping')!.detail).toContain('T2125');
    const us = runCpaReview({ ...clean, uncategorizedExpenseCount: 3 });
    expect(us.findings.find((f) => f.category === 'bookkeeping')!.detail).toContain('Schedule C');
  });
});
