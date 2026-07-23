/**
 * PR-3 (H6/M4): morning-digest tax tips must be jurisdiction-aware and use the
 * tenant's currency — not US-only advice (Schedule C, IRS $75, federal + SE
 * tax) and bare `$` shown to every tenant.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: {} }));

import { generateTaxTipDeterministic, type TipContext } from './agentbook-digest-tips';

const baseCtx = (over: Partial<TipContext>): TipContext => ({
  jurisdiction: 'us',
  currency: 'USD',
  cashTodayCents: 500_00,
  monthlyBurnCents: 0,
  monthlyRevenueCents: 0,
  ytdRevenueCents: 0,
  ytdExpensesCents: 0,
  ytdNetIncomeCents: 0,
  taxDaysUntilQ: null,
  taxQuarterlyEstimateCents: null,
  topCategoriesYtd: [],
  outstandingInvoiceCents: 0,
  upcomingInvoiceCents: 0,
  pastDueInvoiceCount: 0,
  recurringMonthlyCents: 0,
  receiptCoveragePct: 100,
  ...over,
});

describe('generateTaxTipDeterministic — jurisdiction-aware set-aside tip', () => {
  it('US: labels the set-aside "federal + SE tax" and formats in USD', () => {
    const tip = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'us', currency: 'USD', ytdNetIncomeCents: 8_000_000 }));
    expect(tip?.text).toContain('federal + SE tax');
    expect(tip?.text).toContain('$');
  });

  it('CA: does NOT say "federal + SE tax" and formats in CAD', () => {
    const tip = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'ca', currency: 'CAD', ytdNetIncomeCents: 8_000_000 }));
    expect(tip?.text).not.toContain('federal + SE tax');
    expect(tip?.text).toContain('income tax + CPP');
    expect(tip?.text).toMatch(/CA\$|CAD/); // CAD-formatted, not a bare US $
  });

  it('AU: uses a plain income-tax label and AUD formatting', () => {
    const tip = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'au', currency: 'AUD', ytdNetIncomeCents: 8_000_000 }));
    expect(tip?.text).not.toContain('SE tax');
    expect(tip?.text).toContain('income tax');
    expect(tip?.text).toMatch(/A\$|AUD/);
  });
});

describe('generateTaxTipDeterministic — receipt-coverage tip', () => {
  it('US names the $75 IRS threshold', () => {
    const tip = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'us', receiptCoveragePct: 50 }));
    expect(tip?.text).toContain('IRS');
    expect(tip?.text).toContain('$75');
  });

  it('CA/AU do NOT assert the US $75 threshold and name their own agency', () => {
    const ca = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'ca', receiptCoveragePct: 50 }));
    expect(ca?.text).not.toContain('$75');
    expect(ca?.text).toContain('CRA');
    const au = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'au', receiptCoveragePct: 50 }));
    expect(au?.text).not.toContain('$75');
    expect(au?.text).toContain('ATO');
  });
});

describe('generateTaxTipDeterministic — meals 50% tip', () => {
  const meals = { topCategoriesYtd: [{ category: 'Meals', amountCents: 600_00 }] };
  it('US/CA show the 50% meals rule', () => {
    expect(generateTaxTipDeterministic(baseCtx({ jurisdiction: 'us', ...meals }))?.text).toContain('50% rule');
    expect(generateTaxTipDeterministic(baseCtx({ jurisdiction: 'ca', currency: 'CAD', ...meals }))?.text).toContain('T2125');
  });
  it('AU suppresses the 50% meals rule (not applicable)', () => {
    const tip = generateTaxTipDeterministic(baseCtx({ jurisdiction: 'au', currency: 'AUD', ...meals }));
    // No meals tip for AU → either null or a different (non-meals) tip.
    expect(tip?.text ?? '').not.toContain('50% rule');
  });
});
