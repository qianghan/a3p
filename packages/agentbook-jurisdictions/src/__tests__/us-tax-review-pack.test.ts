// packages/agentbook-jurisdictions/src/__tests__/us-tax-review-pack.test.ts
import { describe, it, expect } from 'vitest';
import { UsTaxReviewPack } from '../us/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  ScheduleC: { gross_receipts_1: 9000000, total_expenses_28: 1500000, net_profit_31: 7500000 },
  '1040': { total_income_9: 7500000, taxable_income: 6000000, balance_owing_37: 80000 },
};
const computedTotals = { totalIncomeCents: 7500000, taxableIncomeCents: 6000000, taxPayableCents: 1350000 };

describe('UsTaxReviewPack', () => {
  const pack = new UsTaxReviewPack();

  it('jurisdiction is us', () => {
    expect(pack.jurisdiction).toBe('us');
  });

  it('criticalFields surfaces the real ScheduleC/1040 field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_receipts_1).toMatchObject({ formCode: 'ScheduleC', currentValue: 9000000 });
    expect(byId.total_expenses_28).toMatchObject({ formCode: 'ScheduleC', currentValue: 1500000 });
    expect(byId.taxable_income).toMatchObject({ formCode: '1040', currentValue: 6000000 });
    expect(byId.balance_owing_37).toMatchObject({ formCode: '1040', currentValue: 80000 });
  });

  it('criticalFields tolerates a completely empty forms object', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals, personal context, and names the IRS', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Single, no dependents.', locale: 'en-US' });
    expect(prompt).toContain('$75,000');
    expect(prompt).toContain('$13,500');
    expect(prompt).toContain('Single, no dependents.');
    expect(prompt).toContain('IRS');
  });

  it('summaryPrompt formats the same USD figures per zh-CN number conventions for a Chinese-speaking US tenant — a real Intl.NumberFormat call, not a hardcoded en-US string', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'zh-CN' });
    expect(prompt).toContain(formatCurrency(7500000, 'zh-CN', 'USD'));
  });

  it('parseSummary extracts summaryText', () => {
    expect(pack.parseSummary({ summaryText: 'Your net profit is $75,000...' }).summaryText).toContain('$75,000');
  });

  it('parseSummary throws on a missing summaryText', () => {
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field, current value, and question', () => {
    const field = { formCode: 'ScheduleC', fieldId: 'total_expenses_28', label: 'Total business expenses', currentValue: 1500000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-US', question: 'is this deductible' });
    expect(prompt).toContain('$15,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('is this deductible');
  });

  it('parseFieldExplanation extracts explanation, and throws on a missing one', () => {
    expect(pack.parseFieldExplanation({ explanation: 'Yes, because...' }).explanation).toContain('Yes, because');
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
