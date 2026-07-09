import { describe, it, expect } from 'vitest';
import { computeDeposit, computeSgDeposit, depositDueDate, sgDepositDueDate, quarterOf } from '../payroll-deposits';
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

describe('superannuation guarantee deposits (AU)', () => {
  it('is due 28 days after every calendar quarter end, uniformly for all 4 quarters', () => {
    expect(sgDepositDueDate(2026, 1)).toBe('2026-04-28'); // Jan-Mar quarter
    expect(sgDepositDueDate(2026, 2)).toBe('2026-07-28'); // Apr-Jun quarter
    expect(sgDepositDueDate(2026, 3)).toBe('2026-10-28'); // Jul-Sep quarter
    expect(sgDepositDueDate(2026, 4)).toBe('2027-01-28'); // Oct-Dec quarter, rolls into next year
  });

  it('matches the confirmed-correct dates in the AU jurisdiction pack calendar (super_q1..q4_due)', () => {
    // packages/agentbook-jurisdictions/src/au/calendar-deadlines.ts uses AU-FY
    // quarter labels (FY starts July), so its "Q1" (Jul-Sep) maps to this
    // module's calendar Q3, etc. — the underlying dates must still agree.
    expect(sgDepositDueDate(2026, 3)).toBe('2026-10-28'); // super_q1_due (AU FY)
    expect(sgDepositDueDate(2026, 4)).toBe('2027-01-28'); // super_q2_due (AU FY)
    expect(sgDepositDueDate(2027, 1)).toBe('2027-04-28'); // super_q3_due (AU FY)
    expect(sgDepositDueDate(2027, 2)).toBe('2027-07-28'); // super_q4_due (AU FY)
  });

  it('sums sgCents across stubs into a single quarterly amount, separate from computeDeposit', () => {
    const dep = computeSgDeposit([{ sgCents: 720_00 }, { sgCents: 480_00 }], new Date('2026-05-15'));
    expect(dep.form).toBe('sg');
    expect(dep.periodLabel).toBe('2026-Q2');
    expect(dep.amountCents).toBe(720_00 + 480_00);
    expect(dep.dueDate).toBe('2026-07-28');
  });

  it('defaults to 0 for stubs missing sgCents', () => {
    const dep = computeSgDeposit([{}, { sgCents: 100_00 }], new Date('2026-05-15'));
    expect(dep.amountCents).toBe(100_00);
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

  it('AU Payment Summary reports total superannuation paid separately from withheld tax', () => {
    const f = buildYearEndForm('Alex', 'au', 2026, [
      { grossCents: 6000_00, federalTaxCents: 800_00, stateTaxCents: 0, ficaCents: 0, sgCents: 720_00 },
      { grossCents: 6000_00, federalTaxCents: 800_00, stateTaxCents: 0, ficaCents: 0, sgCents: 720_00 },
    ]);
    expect(f.formType).toBe('Payment Summary');
    expect(f.boxes.superannuationPaidCents).toBe(720_00 + 720_00);
    expect(f.boxes.ficaWithheldCents).toBe(0);
  });

  it('omits the superannuation box entirely for jurisdictions with no super contributions', () => {
    const f = buildYearEndForm('Jane', 'us', 2026, [{ grossCents: 3000_00, federalTaxCents: 400_00, stateTaxCents: 50_00, ficaCents: 229_50 }]);
    expect(f.boxes.superannuationPaidCents).toBeUndefined();
  });
});
