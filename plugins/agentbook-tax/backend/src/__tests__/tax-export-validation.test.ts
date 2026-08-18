// plugins/agentbook-tax/backend/src/__tests__/tax-export-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateFiling } from '../tax-export.js';

// This is the REAL flat shape tax-filing.ts's updateFilingField/populateFiling
// actually write — forms[formCode][fieldId], no `.fields` wrapper.
function realFlatForms(overrides: Record<string, Record<string, any>> = {}) {
  return {
    T1: {
      full_name: 'Jane Doe',
      sin: '123456789',
      total_income_15000: 7300000,
      ...overrides.T1,
    },
    T2125: {
      gross_sales_8000: 8500000,
      adjusted_gross_8299: 8500000,
      total_expenses_9368: 1200000,
      ...overrides.T2125,
    },
    ...overrides,
  };
}

describe('validateFiling against the real flat forms shape', () => {
  it('passes sin_required and name_required when those fields are actually present (flat, no .fields wrapper)', () => {
    const result = validateFiling(realFlatForms());
    const errorIds = result.errors.map((e) => e.ruleId);
    expect(errorIds).not.toContain('sin_required');
    expect(errorIds).not.toContain('name_required');
  });

  it('still flags sin_required when the SIN is genuinely missing', () => {
    const forms = realFlatForms({ T1: { full_name: 'Jane Doe', total_income_15000: 7300000 } });
    const result = validateFiling(forms);
    expect(result.errors.map((e) => e.ruleId)).toContain('sin_required');
  });

  it('income_positive correctly reads the real flat total_income_15000 field', () => {
    const forms = realFlatForms({ T1: { full_name: 'Jane Doe', sin: '1', total_income_15000: -500 } });
    const result = validateFiling(forms);
    expect(result.warnings.map((w) => w.ruleId)).toContain('income_positive');
  });

  it('gst_registration correctly reads real flat gross_sales_8000 against the $30,000 threshold', () => {
    // $35,000 revenue, no GST number on file — over the CA GST/HST registration threshold.
    const forms = realFlatForms({ T2125: { gross_sales_8000: 3500000 } });
    const result = validateFiling(forms);
    expect(result.errors.map((e) => e.ruleId)).toContain('gst_registration');
  });
});

/**
 * The rule set used to be CA-only and applied unconditionally: every filing,
 * whatever its jurisdiction, was checked for `T1.sin` and `T1.full_name`.
 * A US or AU filing has no T1 form at all, so those two rules could never be
 * satisfied — validateFiling always returned valid:false, and submitFiling()
 * / exportFiling() both refuse on invalid. US and AU filings were
 * unsubmittable by construction.
 */
function usForms(overrides: Record<string, Record<string, any>> = {}) {
  return {
    ScheduleC: { gross_receipts_1: 9000000, gross_income_7: 9000000, total_expenses_28: 1200000, ...overrides.ScheduleC },
    '1040': { full_name: 'Jane Doe', ssn: '123456789', total_income_9: 9000000, balance_owing_37: 500000, ...overrides['1040'] },
  };
}

function auForms(overrides: Record<string, Record<string, any>> = {}) {
  return {
    BusinessSchedule: { gross_business_income: 9000000, total_expenses: 1200000, ...overrides.BusinessSchedule },
    IndividualReturn: { full_name: 'Jane Doe', tfn: '123456789', taxable_income: 9000000, balance_owing: 500000, ...overrides.IndividualReturn },
  };
}

describe('validateFiling is jurisdiction-aware', () => {
  it('a complete US filing passes — it is not held to CA\'s T1 SIN/name rules', () => {
    const result = validateFiling(usForms(), 'us');
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('a complete AU filing passes — it is not held to CA\'s T1 SIN/name rules', () => {
    const result = validateFiling(auForms(), 'au');
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('US: flags a missing SSN and a missing name on the 1040', () => {
    const result = validateFiling(usForms({ '1040': { total_income_9: 9000000, ssn: undefined, full_name: undefined } }), 'us');
    const ids = result.errors.map((e) => e.ruleId);
    expect(ids).toContain('ssn_required');
    expect(ids).toContain('name_required');
  });

  it('AU: flags a missing TFN and a missing name on the IndividualReturn', () => {
    const result = validateFiling(auForms({ IndividualReturn: { taxable_income: 9000000, tfn: undefined, full_name: undefined } }), 'au');
    const ids = result.errors.map((e) => e.ruleId);
    expect(ids).toContain('tfn_required');
    expect(ids).toContain('name_required');
  });

  it('US: does NOT apply the CA GST/HST registration rule', () => {
    const result = validateFiling(usForms(), 'us');
    expect(result.errors.map((e) => e.ruleId)).not.toContain('gst_registration');
  });

  it('US: still warns when Schedule C expenses swallow almost all revenue', () => {
    const result = validateFiling(usForms({ ScheduleC: { gross_receipts_1: 9000000, gross_income_7: 9000000, total_expenses_28: 8900000 } }), 'us');
    expect(result.warnings.map((w) => w.ruleId)).toContain('expenses_ratio');
  });

  it('AU: still warns when business expenses swallow almost all revenue', () => {
    const result = validateFiling(auForms({ BusinessSchedule: { gross_business_income: 9000000, total_expenses: 8900000 } }), 'au');
    expect(result.warnings.map((w) => w.ruleId)).toContain('expenses_ratio');
  });

  it('defaults to the CA rule set when no jurisdiction is given (back-compat)', () => {
    const result = validateFiling(realFlatForms());
    expect(result.errors.map((e) => e.ruleId)).not.toContain('sin_required');
    expect(validateFiling(realFlatForms({ T1: { full_name: 'Jane Doe' } })).errors.map((e) => e.ruleId))
      .toContain('sin_required');
  });

  it('an unknown jurisdiction falls back to the CA rules rather than validating nothing', () => {
    // Silently returning valid:true for an unrecognised jurisdiction would
    // let a filing through with no identity fields at all.
    const result = validateFiling({ T1: {} }, 'nz');
    expect(result.valid).toBe(false);
  });
});
