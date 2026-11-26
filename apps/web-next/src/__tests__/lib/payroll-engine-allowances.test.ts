import { describe, it, expect } from 'vitest';
import { calcPay, splitCaDeductions } from '@/lib/payroll-engine';

/**
 * Launch finding F2: withholding ignored the US standard deduction, the
 * Canadian basic personal amounts and the CPP/QPP $3,500 exemption, so every
 * stub over-withheld. Each expectation is hand-computed from the statute.
 */
const pay = (jurisdiction: string, grossCents: number, region?: string, filingStatus = 'single') =>
  calcPay({ jurisdiction, grossCents, payPeriodsPerYear: 26, filingStatus, region });

describe('US federal standard deduction', () => {
  it('taxes only income above $14,600 (single): $26,000/yr → $1,140/yr → $43.85/period', () => {
    expect(pay('us', 100000, 'TX').federalTaxCents).toBe(4385);
  });
  it('a married filer gets $29,200: $26,000/yr withholds $0 federal', () => {
    expect(pay('us', 100000, 'TX', 'married').federalTaxCents).toBe(0);
  });
  it('income below the deduction withholds $0, never a negative amount', () => {
    expect(pay('us', 20000, 'VA').federalTaxCents).toBe(0);
    expect(pay('us', 20000, 'VA').stateTaxCents).toBe(0);
  });
});

describe('US state brackets', () => {
  it('New York runs its brackets after its $8,000 deduction, not the 10.9% top rate', () => {
    // $104,000 − $8,000 = $96,000: 340 + 144 + 115.50 + 3,671.25 + 921.00 = $5,191.75/yr → $199.68.
    expect(pay('us', 400000, 'NY').stateTaxCents).toBe(19968);
  });
});

describe('Canada basic personal amounts and CPP exemption', () => {
  it('Ontario $26,000/yr: federal (26,000 − 16,129) × 15% and provincial (26,000 − 12,747) × 5.05%', () => {
    const r = pay('ca', 100000, 'ON');
    expect(r.federalTaxCents).toBe(5695); // $1,480.65 / 26
    expect(r.stateTaxCents).toBe(2574); // $669.28 / 26
  });
  it('CPP is 5.95% of earnings above $3,500; EI has no exemption', () => {
    const split = splitCaDeductions(2_600_000);
    expect(split.pensionCents).toBe(133875); // (26,000 − 3,500) × 5.95%
    expect(split.eiCents).toBe(43160);
  });
  it('QPP also starts above $3,500, and a $13,000 Quebec earner owes no income tax', () => {
    expect(splitCaDeductions(1_300_000, 'QC').pensionCents).toBe(60800); // 9,500 × 6.40%
    const r = pay('ca', 50000, 'QC');
    expect([r.federalTaxCents, r.stateTaxCents]).toEqual([0, 0]);
  });
});
