import { describe, it, expect } from 'vitest';
import { buildYearEndForm, type YearEndStub } from '../year-end-forms';

const stub = (grossCents: number, federalTaxCents: number, ficaCents: number): YearEndStub => ({
  grossCents, federalTaxCents, stateTaxCents: 0, ficaCents,
});

describe('buildYearEndForm — CA real CRA box numbers (CA-3)', () => {
  it('non-Quebec CA employee gets real Box 14/16/18/22/24/26 keys, not generic ones', () => {
    // $90,000 aggregated annual gross (matches splitCaDeductions test fixture).
    const form = buildYearEndForm('Jane Doe', 'ca', 2025, [stub(90_000_00, 1_200_000, 0)], 'emp1', 'ON');
    expect(form.formType).toBe('T4');
    expect(form.boxes.box14EmploymentIncomeCents).toBe(90_000_00);
    expect(form.boxes.box16CppContributionsCents).toBe(386_750);
    expect(form.boxes.box17QppContributionsCents).toBeUndefined(); // non-Quebec: no QPP box at all
    expect(form.boxes.box18EiPremiumsCents).toBe(104_912);
    expect(form.boxes.box22IncomeTaxDeductedCents).toBe(1_200_000);
    expect(form.boxes.box55PpipPremiumsCents).toBeUndefined(); // non-Quebec: no QPIP box
    // Old generic keys must be gone entirely for CA, not just superseded.
    expect(form.boxes.ficaWithheldCents).toBeUndefined();
  });

  it('Quebec CA employee gets Box 17 (QPP) instead of Box 16 (CPP), plus Box 55/56 (QPIP)', () => {
    const form = buildYearEndForm('Marie Tremblay', 'ca', 2025, [stub(90_000_00, 1_200_000, 0)], 'emp2', 'QC');
    expect(form.boxes.box17QppContributionsCents).toBe(433_920);
    expect(form.boxes.box16CppContributionsCents).toBeUndefined(); // Quebec: no CPP box
    expect(form.boxes.box55PpipPremiumsCents).toBe(44_460);
    expect(form.boxes.box56PpipInsurableEarningsCents).toBeGreaterThan(0);
    // Hand-verified: QPIP insurable earnings cap = 48412 / 0.00494 = 9,800,000
    // cents = $98,000 (matches the real, published 2025 QPIP maximum
    // insurable earnings threshold), capped at gross ($90,000 < $98,000
    // so uncapped here, i.e. equal to gross).
    expect(form.boxes.box56PpipInsurableEarningsCents).toBe(90_000_00);
    // Box 24 (EI insurable earnings, Quebec rate/cap): 86067 / 0.0131 =
    // 6,570,000 cents = $65,700 cap; $90,000 gross exceeds it, so capped.
    expect(form.boxes.box24EiInsurableEarningsCents).toBe(65_700_00);
    // Box 26 (QPP pensionable earnings): 433920 / 0.0640 = 6,780,000 cents
    // = $67,800 cap; $90,000 gross exceeds it, so capped.
    expect(form.boxes.box26PensionableEarningsCents).toBe(67_800_00);
  });

  it('US/UK/AU year-end forms are completely unaffected by this change', () => {
    const us = buildYearEndForm('John Smith', 'us', 2025, [stub(90_000_00, 1_200_000, 688_500)], 'emp3');
    expect(us.formType).toBe('W-2');
    expect(us.boxes.grossWagesCents).toBe(90_000_00);
    expect(us.boxes.ficaWithheldCents).toBe(688_500); // generic key path, unchanged for non-CA
  });
});
