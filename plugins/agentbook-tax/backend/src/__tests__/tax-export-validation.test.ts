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
