import { describe, it, expect } from 'vitest';
import { AuTaxReviewPack } from '../au/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  BusinessSchedule: { gross_business_income: 9500000, total_expenses: 1800000, net_business_income: 7700000 },
  IndividualReturn: { taxable_income: 7700000, total_tax_payable: 1600000, balance_owing: 100000 },
};
const computedTotals = { totalIncomeCents: 7700000, taxableIncomeCents: 7700000, taxPayableCents: 1600000 };

describe('AuTaxReviewPack', () => {
  const pack = new AuTaxReviewPack();

  it('jurisdiction is au', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  it('criticalFields surfaces the real BusinessSchedule/IndividualReturn field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_business_income).toMatchObject({ formCode: 'BusinessSchedule', currentValue: 9500000 });
    expect(byId.net_business_income).toMatchObject({ formCode: 'BusinessSchedule', currentValue: 7700000 });
    expect(byId.taxable_income).toMatchObject({ formCode: 'IndividualReturn', currentValue: 7700000 });
    expect(byId.balance_owing).toMatchObject({ formCode: 'IndividualReturn', currentValue: 100000 });
  });

  it('criticalFields tolerates a completely empty forms object', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals, personal context, and names the ATO', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Sole trader, no dependents.', locale: 'en-AU' });
    expect(prompt).toContain('$77,000');
    expect(prompt).toContain('$16,000');
    expect(prompt).toContain('Sole trader, no dependents.');
    expect(prompt).toContain('ATO');
  });

  it('summaryPrompt formats the same AUD figures per zh-CN number conventions for a Chinese-speaking AU tenant', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'zh-CN' });
    expect(prompt).toContain(formatCurrency(7700000, 'zh-CN', 'AUD'));
  });

  it('parseSummary extracts summaryText, and throws on a missing one', () => {
    expect(pack.parseSummary({ summaryText: 'Your net business income is A$77,000...' }).summaryText).toContain('77,000');
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field, current value, and question, formatted as AUD', () => {
    const field = { formCode: 'BusinessSchedule', fieldId: 'total_expenses', label: 'Total business expenses', currentValue: 1800000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-AU', question: 'why so high' });
    expect(prompt).toContain('$18,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('why so high');
  });

  it('parseFieldExplanation extracts explanation, and throws on a missing one', () => {
    expect(pack.parseFieldExplanation({ explanation: 'Because...' }).explanation).toContain('Because');
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
