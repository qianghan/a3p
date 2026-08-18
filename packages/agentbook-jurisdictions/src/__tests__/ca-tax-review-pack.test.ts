// packages/agentbook-jurisdictions/src/__tests__/ca-tax-review-pack.test.ts
import { describe, it, expect } from 'vitest';
import { CaTaxReviewPack } from '../ca/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  T2125: { gross_sales_8000: 8500000, total_expenses_9368: 1200000, net_income_9369: 7300000 },
  T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, balance_owing_48500: 50000 },
};
const computedTotals = { totalIncomeCents: 7300000, taxableIncomeCents: 7300000, taxPayableCents: 1150000 };

describe('CaTaxReviewPack', () => {
  const pack = new CaTaxReviewPack();

  it('jurisdiction is ca', () => {
    expect(pack.jurisdiction).toBe('ca');
  });

  it('criticalFields surfaces the real T2125/T1 field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_sales_8000).toMatchObject({ formCode: 'T2125', currentValue: 8500000 });
    expect(byId.total_expenses_9368).toMatchObject({ formCode: 'T2125', currentValue: 1200000 });
    expect(byId.taxable_income_26000).toMatchObject({ formCode: 'T1', currentValue: 7300000 });
    expect(byId.balance_owing_48500).toMatchObject({ formCode: 'T1', currentValue: 50000 });
    expect(byId.gross_sales_8000.label).toMatch(/business sales|gross sales/i);
  });

  it('criticalFields tolerates a completely empty forms object (new filing, nothing entered yet)', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals and personal profile context, en-CA formatting', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Married, no dependents.', locale: 'en-CA' });
    expect(prompt).toContain('$73,000');
    expect(prompt).toContain('$11,500');
    expect(prompt).toContain('Married, no dependents.');
    expect(prompt).toContain('CRA');
  });

  it('summaryPrompt formats the SAME figures per fr-CA number conventions when the tenant is Quebec French — this is a real Intl.NumberFormat call, not a hardcoded en-CA string', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'fr-CA' });
    // fr-CA groups with a narrow no-break space and puts the symbol after the
    // amount — assert via the real formatCurrency('fr-CA') output rather than
    // a hand-typed literal, since the exact whitespace character Intl uses
    // is easy to get wrong by hand and isn't the point of this test.
    expect(prompt).toContain(formatCurrency(7300000, 'fr-CA', 'CAD'));
  });

  it('parseSummary extracts summaryText', () => {
    const result = pack.parseSummary({ summaryText: 'Your net business income is $73,000...' });
    expect(result.summaryText).toContain('$73,000');
  });

  it('parseSummary throws on a missing summaryText', () => {
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field and its current value', () => {
    const field = { formCode: 'T2125', fieldId: 'total_expenses_9368', label: 'Total business expenses', currentValue: 1200000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-CA', question: 'why is this so high' });
    expect(prompt).toContain('$12,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('why is this so high');
  });

  it('parseFieldExplanation extracts explanation', () => {
    const result = pack.parseFieldExplanation({ explanation: 'This total includes...' });
    expect(result.explanation).toContain('This total includes');
  });

  it('parseFieldExplanation throws on a missing explanation', () => {
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
