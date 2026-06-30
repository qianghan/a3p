import { describe, it, expect } from 'vitest';
import { computeDeposit, depositDueDate, quarterOf } from '../payroll-deposits';
import { buildYearEndForm } from '../year-end-forms';

describe('payroll tax deposits', () => {
  it('quarter + due date: Q2 is due Jul 31', () => {
    expect(quarterOf(new Date('2026-05-15')).q).toBe(2);
    expect(depositDueDate(2026, 2)).toBe('2026-07-31');
  });

  it('Q4 deposit is due Jan 31 of the next year', () => {
    expect(depositDueDate(2026, 4)).toBe('2027-01-31');
  });

  it('US 941 = income tax + employee FICA + employer match', () => {
    const d = computeDeposit(
      [{ federalTaxCents: 400_00, stateTaxCents: 0, ficaCents: 229_50 }],
      'us',
      new Date('2026-05-15'),
    );
    expect(d.form).toBe('941');
    expect(d.periodLabel).toBe('2026-Q2');
    // 400 + 229.50 + 229.50 (employer match)
    expect(d.amountCents).toBe(400_00 + 229_50 + 229_50);
  });

  it('CA uses t4 form and no employer match in this approximation', () => {
    const d = computeDeposit([{ federalTaxCents: 300_00, stateTaxCents: 0, ficaCents: 150_00 }], 'ca', new Date('2026-02-10'));
    expect(d.form).toBe('t4');
    expect(d.amountCents).toBe(300_00 + 150_00);
  });
});

describe('year-end forms', () => {
  it('US produces a W-2 with summed boxes', () => {
    const f = buildYearEndForm('Jane', 'us', 2026, [
      { grossCents: 3000_00, federalTaxCents: 400_00, stateTaxCents: 50_00, ficaCents: 229_50 },
      { grossCents: 3000_00, federalTaxCents: 400_00, stateTaxCents: 50_00, ficaCents: 229_50 },
    ]);
    expect(f.formType).toBe('W-2');
    expect(f.boxes.grossWagesCents).toBe(6000_00);
    expect(f.boxes.incomeTaxWithheldCents).toBe(800_00);
    expect(f.boxes.ficaWithheldCents).toBe(459_00);
  });

  it('CA produces a T4', () => {
    const f = buildYearEndForm('Maya', 'ca', 2026, [{ grossCents: 5000_00, federalTaxCents: 600_00, stateTaxCents: 0, ficaCents: 300_00 }]);
    expect(f.formType).toBe('T4');
    expect(f.boxes.grossWagesCents).toBe(5000_00);
  });
});
