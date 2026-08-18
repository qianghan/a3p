// packages/agentbook-jurisdictions/src/us/tax-review-pack.ts
import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const US_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'ScheduleC', fieldId: 'gross_receipts_1', label: 'Gross business receipts' },
  { formCode: 'ScheduleC', fieldId: 'total_expenses_28', label: 'Total business expenses' },
  { formCode: '1040', fieldId: 'total_income_9', label: 'Total income' },
  { formCode: '1040', fieldId: 'taxable_income', label: 'Taxable income' },
  { formCode: '1040', fieldId: 'balance_owing_37', label: 'Amount you owe (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n), not a
// local re-implementation — see Task 6's note and Task 7's identical CA
// treatment.
function fmtUsd(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'USD');
}

export class UsTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'us';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return US_CRITICAL_FIELDS.map((f) => ({ ...f, currentValue: forms[f.formCode]?.[f.fieldId] ?? null }));
  }

  summaryPrompt(input: { forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are a U.S. tax preparer giving a freelance/self-employed client a plain-language summary of their Form 1040 filing before they submit it. You do NOT calculate any figures yourself — every number below already comes from the IRS's own federal bracket tables and this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtUsd(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtUsd(computedTotals.taxableIncomeCents, locale)}
- Tax payable: ${fmtUsd(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the IRS by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"summaryText": "<the summary text>"}`;
  }

  parseSummary(parsed: unknown): { summaryText: string } {
    const r = parsed as any;
    if (r && typeof r.summaryText === 'string' && r.summaryText.trim().length > 0) return { summaryText: r.summaryText };
    throw new Error('Unexpected review-summary response shape: ' + JSON.stringify(parsed));
  }

  explainFieldPrompt(input: { field: CriticalField; forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string; question?: string }): string {
    const { field, personalProfileContext, locale, question } = input;
    const valueStr = typeof field.currentValue === 'number' ? fmtUsd(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are a U.S. tax preparer answering a client's question about one specific number on their Form 1040 filing. Ground your answer ONLY in the value given below and general IRS rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the IRS by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) return { explanation: r.explanation };
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
