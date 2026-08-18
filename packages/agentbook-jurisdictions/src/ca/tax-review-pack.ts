// packages/agentbook-jurisdictions/src/ca/tax-review-pack.ts
import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const CA_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'T2125', fieldId: 'gross_sales_8000', label: 'Gross business sales' },
  { formCode: 'T2125', fieldId: 'total_expenses_9368', label: 'Total business expenses' },
  { formCode: 'T1', fieldId: 'total_income_15000', label: 'Total income' },
  { formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income' },
  { formCode: 'T1', fieldId: 'balance_owing_48500', label: 'Balance owing (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n) — not a
// local re-implementation. formatCurrency(4500, 'fr-CA', 'CAD') -> "45,00 $",
// formatCurrency(4500, 'en-CA', 'CAD') -> "$45.00": same jurisdiction (CAD is
// fixed by being the CA pack), different formatting per the tenant's own
// locale. See Task 6's note on why locale and language-of-reply are
// deliberately two different things.
function fmtCad(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'CAD');
}

export class CaTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'ca';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return CA_CRITICAL_FIELDS.map((f) => ({
      ...f,
      currentValue: forms[f.formCode]?.[f.fieldId] ?? null,
    }));
  }

  summaryPrompt(input: {
    forms: Record<string, Record<string, any>>;
    computedTotals: ComputedFilingTotals;
    personalProfileContext: string;
    locale: string;
  }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are a Canadian tax preparer giving a freelance/self-employed client a plain-language summary of their T1 filing before they submit it. You do NOT calculate any figures yourself — every number below already comes from the CRA's own federal/provincial bracket tables and this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtCad(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtCad(computedTotals.taxableIncomeCents, locale)}
- Tax payable: ${fmtCad(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the CRA by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"summaryText": "<the summary text>"}`;
  }

  parseSummary(parsed: unknown): { summaryText: string } {
    const r = parsed as any;
    if (r && typeof r.summaryText === 'string' && r.summaryText.trim().length > 0) {
      return { summaryText: r.summaryText };
    }
    throw new Error('Unexpected review-summary response shape: ' + JSON.stringify(parsed));
  }

  explainFieldPrompt(input: {
    field: CriticalField;
    forms: Record<string, Record<string, any>>;
    computedTotals: ComputedFilingTotals;
    personalProfileContext: string;
    locale: string;
    question?: string;
  }): string {
    const { field, personalProfileContext, locale, question } = input;
    const valueStr = typeof field.currentValue === 'number' ? fmtCad(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are a Canadian tax preparer answering a client's question about one specific number on their T1 filing. Ground your answer ONLY in the value given below and general CRA rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the CRA by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) {
      return { explanation: r.explanation };
    }
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
