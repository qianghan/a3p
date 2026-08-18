import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const AU_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'BusinessSchedule', fieldId: 'gross_business_income', label: 'Gross business income' },
  { formCode: 'BusinessSchedule', fieldId: 'total_expenses', label: 'Total business expenses' },
  { formCode: 'BusinessSchedule', fieldId: 'net_business_income', label: 'Net business income' },
  { formCode: 'IndividualReturn', fieldId: 'taxable_income', label: 'Taxable income' },
  { formCode: 'IndividualReturn', fieldId: 'balance_owing', label: 'Amount you owe (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n), not a
// local re-implementation — see Task 6's note and Task 7's identical CA
// treatment.
function fmtAud(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'AUD');
}

export class AuTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'au';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return AU_CRITICAL_FIELDS.map((f) => ({ ...f, currentValue: forms[f.formCode]?.[f.fieldId] ?? null }));
  }

  summaryPrompt(input: { forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are an Australian tax agent giving a sole-trader client a plain-language summary of their individual tax return before they submit it. You do NOT calculate any figures yourself — every number below already comes from the ATO's own tax brackets and Medicare Levy rate, applied to this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtAud(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtAud(computedTotals.taxableIncomeCents, locale)}
- Tax payable (including Medicare Levy): ${fmtAud(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the ATO by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

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
    const valueStr = typeof field.currentValue === 'number' ? fmtAud(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are an Australian tax agent answering a client's question about one specific number on their individual tax return. Ground your answer ONLY in the value given below and general ATO rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the ATO by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) return { explanation: r.explanation };
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
