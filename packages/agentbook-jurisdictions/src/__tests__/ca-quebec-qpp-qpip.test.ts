import { describe, expect, it } from 'vitest';
import { caSelfEmploymentTax } from '../ca/self-employment-tax.js';
import { estimateTotalIncomeTax } from '../total-tax.js';

/**
 * A Quebec resident does not contribute to the CPP. They contribute to the
 * QPP at a higher rate, and must also pay QPIP premiums, which are
 * compulsory for the self-employed where EI is optional elsewhere.
 *
 * We applied CPP rates to every Canadian and omitted QPIP entirely, so a
 * Quebec sole trader's obligation — and therefore their tax reserve — came
 * out roughly CAD 1,470 a year light at the ceilings.
 */

const YEAR = 2025;
const AT_MPE = 7_130_000;         // $71,300, the base ceiling
const HIGH = 12_000_000;          // $120,000 — past every ceiling
const MID = 5_000_000;            // $50,000

describe('Quebec pays QPP, not CPP', () => {
  it('charges 12.80% where the rest of Canada pays 11.90%', () => {
    const qc = caSelfEmploymentTax.calculate(AT_MPE, YEAR, { region: 'QC' });
    const on = caSelfEmploymentTax.calculate(AT_MPE, YEAR, { region: 'ON' });
    // (71,300 - 3,500) x 12.80% = $8,678.40 — the figure Revenu Québec
    // publishes as the maximum base contribution, which is what makes this
    // a check on the rate rather than a restatement of it.
    expect(qc.breakdown.qpp).toBe(867_840);
    expect(on.breakdown.cpp).toBe(806_820); // 67,800 x 11.90%
    expect(qc.breakdown.qpp).toBeGreaterThan(on.breakdown.cpp);
  });

  it('names the Quebec plans in the breakdown rather than mislabelling them CPP', () => {
    const qc = caSelfEmploymentTax.calculate(MID, YEAR, { region: 'QC' });
    expect(Object.keys(qc.breakdown).sort()).toEqual(['ei', 'qpip', 'qpp', 'qpp2']);
    expect(qc.breakdown).not.toHaveProperty('cpp');
  });

  it('recognises Quebec however the province is cased or padded', () => {
    for (const r of ['QC', 'qc', ' Qc ']) {
      expect(caSelfEmploymentTax.calculate(MID, YEAR, { region: r }).breakdown.qpp).toBeGreaterThan(0);
    }
  });

  it('applies the same second-tier band to both, since only the base rate differs', () => {
    const qc = caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'QC' });
    const on = caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'ON' });
    // (81,200 - 71,300) x 8% = $792
    expect(qc.breakdown.qpp2).toBe(79_200);
    expect(on.breakdown.cpp2).toBe(79_200);
  });
});

describe('QPIP is compulsory, and was missing entirely', () => {
  it('charges 0.878% up to the $98,000 ceiling', () => {
    // Max premium $860.44 — the published figure.
    expect(caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'QC' }).breakdown.qpip).toBe(86_044);
  });

  it('has no basic exemption, unlike the pension plan', () => {
    // 50,000 x 0.878% = $439. A $3,500 exemption would give $407.13.
    expect(caSelfEmploymentTax.calculate(MID, YEAR, { region: 'QC' }).breakdown.qpip).toBe(43_900);
  });

  it('is not payable below the $2,000 income floor', () => {
    expect(caSelfEmploymentTax.calculate(199_900, YEAR, { region: 'QC' }).breakdown.qpip).toBe(0);
    expect(caSelfEmploymentTax.calculate(200_000, YEAR, { region: 'QC' }).breakdown.qpip).toBeGreaterThan(0);
  });

  it('uses the 2026 rate cut for a 2026 estimate', () => {
    const y2026 = caSelfEmploymentTax.calculate(HIGH, 2026, { region: 'QC' }).breakdown.qpip;
    expect(y2026).toBe(Math.round(9_800_000 * 0.00764));
    expect(y2026).toBeLessThan(86_044);
  });

  it('is never charged outside Quebec', () => {
    for (const r of ['ON', 'BC', 'AB', '', null, undefined]) {
      expect(caSelfEmploymentTax.calculate(HIGH, YEAR, { region: r }).breakdown.qpip).toBeUndefined();
    }
  });
});

describe('what the tenant actually pays', () => {
  it('a Quebec freelancer past the ceilings owes ~$1,470 more than we told them', () => {
    const qc = caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'QC' }).amountCents;
    const on = caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'ON' }).amountCents;
    const gap = qc - on;
    // 61,020c rate gap + 86,044c QPIP = 147,064c ≈ CAD 1,470.
    expect(gap).toBe(147_064);
  });

  it('reaches the total-tax estimate, not just the pure calculator', () => {
    // The wiring layer. `total-tax.ts` already received `region` and used it
    // only for provincial income tax; the SE calculator never saw it, so
    // fixing the calculator alone would have changed nothing a user sees.
    const qc = estimateTotalIncomeTax(HIGH, 'ca', 'QC', YEAR);
    const on = estimateTotalIncomeTax(HIGH, 'ca', 'ON', YEAR);
    expect(qc.seTaxCents).toBeGreaterThan(on.seTaxCents);
    expect(qc.seTaxCents - on.seTaxCents).toBe(147_064);
  });

  it('leaves the rest of Canada exactly where it was', () => {
    // No silent change for the majority of Canadian tenants.
    const on = caSelfEmploymentTax.calculate(HIGH, YEAR, { region: 'ON' });
    expect(on.amountCents).toBe(806_820 + 79_200);
    expect(on.deductiblePortionCents).toBe(Math.round((806_820 + 79_200) / 2));
  });
});
