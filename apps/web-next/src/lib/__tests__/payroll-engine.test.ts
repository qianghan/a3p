import { describe, it, expect } from 'vitest';
import { calcPay, periodGross, PERIODS_PER_YEAR, US_STATE_INCOME_TAX_RATES } from '../payroll-engine';

describe('payroll engine', () => {
  it('periodGross splits annual salary by frequency', () => {
    expect(periodGross(78_000_00, 'biweekly')).toBe(Math.round(78_000_00 / 26));
    expect(periodGross(120_000_00, 'monthly')).toBe(120_000_00 / 12);
  });

  it('US: gross = federal + FICA + net (no leakage)', () => {
    const r = calcPay({ jurisdiction: 'us', grossCents: periodGross(78_000_00, 'biweekly'), payPeriodsPerYear: 26 });
    expect(r.federalTaxCents).toBeGreaterThan(0);
    expect(r.ficaCents).toBeGreaterThan(0);
    expect(r.federalTaxCents + r.ficaCents + r.stateTaxCents + r.netCents).toBe(r.grossCents);
  });

  it('US FICA on a biweekly $3000 check ≈ 7.65%', () => {
    const r = calcPay({ jurisdiction: 'us', grossCents: 3_000_00, payPeriodsPerYear: 26 });
    // SS 6.2% + Medicare 1.45% = 7.65% under the wage base
    expect(r.ficaCents).toBe(Math.round(Math.min(3_000_00 * 26, 168_600_00) * 0.062 / 26) + Math.round(3_000_00 * 0.0145));
  });

  it('married brackets withhold less than single at the same gross', () => {
    const single = calcPay({ jurisdiction: 'us', grossCents: 5_000_00, payPeriodsPerYear: 26, filingStatus: 'single' });
    const married = calcPay({ jurisdiction: 'us', grossCents: 5_000_00, payPeriodsPerYear: 26, filingStatus: 'married' });
    expect(married.federalTaxCents).toBeLessThan(single.federalTaxCents);
  });

  it('Canada applies CPP+EI as fica and stays balanced', () => {
    const r = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26 });
    expect(r.ficaCents).toBeGreaterThan(0);
    expect(r.federalTaxCents + r.ficaCents + r.netCents).toBe(r.grossCents);
  });

  it('Quebec employees pay QPP+QC-EI+QPIP instead of CPP+rest-of-Canada-EI, and stay balanced', () => {
    const nonQc = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'ON' });
    const qc = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'QC' });

    // QPP's higher rate (6.40% vs CPP's 5.95%) plus the added QPIP premium
    // should make Quebec's total fica deduction higher than the rest of
    // Canada's, even though Quebec's own EI portion is lower.
    expect(qc.ficaCents).toBeGreaterThan(nonQc.ficaCents);
    expect(qc.federalTaxCents + qc.ficaCents + qc.netCents).toBe(qc.grossCents);
  });

  it('Quebec fica caps at the real 2025 QPP+QC-EI+QPIP maximums for a high earner', () => {
    // At $200,000/year (well above all three deductions' maximum insurable/
    // pensionable earnings), Quebec's fica should hit the sum of all three
    // real 2025 annual maximums: QPP $4,339.20 + QC-EI $860.67 + QPIP
    // $484.12 = $5,683.99 = 568399 cents (rounding each cap independently,
    // per-paycheck, then summing — see Step 4 for the exact per-period math).
    const r = calcPay({ jurisdiction: 'ca', grossCents: periodGross(200_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'QC' });
    // Hand-verified: 568399 / 26 = 21861.5 exactly (21861 * 26 = 568386,
    // remainder 13, 13/26 = 0.5) -> Math.round rounds half up -> 21862.
    // periodGross(200_000_00, 'biweekly') = round(20_000_000 / 26) = 769231
    // cents/period, so calcCA's internal annual = 769231 * 26 = 20_000_006
    // cents (off from $200,000 by 6 cents due to the per-period rounding
    // baked into periodGross) — this tiny difference doesn't change which
    // of the three deductions are capped, since all three are capped at far
    // lower earnings thresholds than $200k regardless (QPP caps at $71,300,
    // EI at $65,700, QPIP at $98,000 of pensionable/insurable earnings).
    expect(r.ficaCents).toBe(21862);
  });

  it('a non-QC Canadian province is unaffected by this change (existing CPP+EI behavior)', () => {
    const before = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'BC' });
    // Pinned against the current (unchanged) CPP+EI computation: annual =
    // round(9_000_000/26)*26 = 346154*26 = 9_000_004 cents. CPP = min(round
    // (9_000_004*0.0595), 386750) = min(535500, 386750) = 386750 (capped).
    // EI = min(round(9_000_004*0.0166), 104912) = min(149400, 104912) =
    // 104912 (capped). fica = round((386750+104912)/26) = round(18910.08)
    // = 18910.
    expect(before.ficaCents).toBe(18910);
  });

  it('UK gives a tax-free personal allowance (low earner pays no PAYE)', () => {
    const r = calcPay({ jurisdiction: 'uk', grossCents: periodGross(10_000_00, 'monthly'), payPeriodsPerYear: 12 });
    expect(r.federalTaxCents).toBe(0);
  });

  it('Australia super is employer-side, so fica withheld is 0', () => {
    const r = calcPay({ jurisdiction: 'au', grossCents: periodGross(80_000_00, 'monthly'), payPeriodsPerYear: 12 });
    expect(r.ficaCents).toBe(0);
    expect(r.federalTaxCents).toBeGreaterThan(0);
  });

  it('Australia superannuation guarantee is 12% of gross, additive on top (not subtracted from net)', () => {
    const gross = periodGross(80_000_00, 'monthly');
    const r = calcPay({ jurisdiction: 'au', grossCents: gross, payPeriodsPerYear: 12 });
    expect(r.sgCents).toBe(Math.round(gross * 0.12));
    // net = gross - federalTax only; sg never reduces net pay.
    expect(r.netCents).toBe(r.grossCents - r.federalTaxCents);
  });

  it('sgCents is 0 for every non-AU jurisdiction', () => {
    expect(calcPay({ jurisdiction: 'us', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
    expect(calcPay({ jurisdiction: 'ca', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
    expect(calcPay({ jurisdiction: 'uk', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
  });

  it('all frequencies are defined', () => {
    expect(Object.keys(PERIODS_PER_YEAR)).toEqual(['weekly', 'biweekly', 'semimonthly', 'monthly']);
  });
});

describe('US_STATE_INCOME_TAX_RATES completeness (US-GATE remediation)', () => {
  const ALL_US_STATES_AND_DC = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
    'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
    'WI','WY','DC',
  ];

  it('US_STATE_INCOME_TAX_RATES has an own, explicit entry for every US state + DC — exactly 51, none more or fewer', () => {
    // A real membership check against the exported table itself — not just
    // calcPay's `?? 0` output, which can't tell "genuinely zero" apart from
    // "entry deleted". This is the test that actually fails if a future
    // edit removes a state: Object.keys would simply be shorter.
    const tableKeys = Object.keys(US_STATE_INCOME_TAX_RATES).sort();
    expect(tableKeys).toEqual([...ALL_US_STATES_AND_DC].sort());
    expect(tableKeys.length).toBe(51);
    for (const state of ALL_US_STATES_AND_DC) {
      expect(Object.prototype.hasOwnProperty.call(US_STATE_INCOME_TAX_RATES, state)).toBe(true);
      expect(typeof US_STATE_INCOME_TAX_RATES[state]).toBe('number');
    }
  });

  it('the 9 no-income-tax states still withhold an explicit real $0', () => {
    for (const state of ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']) {
      const result = calcPay({
        jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26,
        filingStatus: 'single', region: state,
      });
      expect(result.stateTaxCents).toBe(0);
    }
  });

  it('previously-uncovered states (e.g. VA, MA, WI) now withhold real non-zero state tax, not the old silent $0', () => {
    // Before this fix, any state outside the original 15-state table fell
    // through `?? 0`, withholding $0 indistinguishable from a genuine
    // no-income-tax state. $5,000.00 gross at VA's 5.75% flat approximation
    // = $287.50 = 28750 cents.
    const va = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'VA' });
    expect(va.stateTaxCents).toBe(28750);

    // MA at 9.00% top-marginal approximation = $450.00 = 45000 cents.
    const ma = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'MA' });
    expect(ma.stateTaxCents).toBe(45000);

    // WI at 7.65% top-marginal approximation = $382.50 = 38250 cents.
    const wi = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'WI' });
    expect(wi.stateTaxCents).toBe(38250);
  });
});
