/**
 * PR 2b.8 — tax phrasing on chat record-expense.
 *
 * "$110 incl GST" / "$100 + GST" / "$113 with HST" / "incl. QST" become
 * `taxCode` + `taxInclusive` on the params POSTed to /agentbook-expense/expenses,
 * where resolveExpenseTax (apps/web-next/src/lib/expense-tax.ts) does the
 * maths — the same resolution web, mobile capture and receipts use. This
 * module only recognises words; it never computes tax.
 */

export interface TaxPhrase {
  taxCode: string;
  taxInclusive: boolean;
}

const TAX_WORD = String.raw`(?:GST|HST|QST|PST)`;
// A run of tax words joined by "+", "/", "and", "&" ("GST+PST", "GST and QST").
const TAX_RUN = String.raw`${TAX_WORD}(?:\s*(?:\+|/|&|and)\s*${TAX_WORD})?`;
const INCL = new RegExp(String.raw`\b(?:incl(?:uding|usive(?:\s+of)?)?|inc)\.?\s+(${TAX_RUN})\b|\b(?:with|w/)\s+(${TAX_RUN})\b`, 'i');
const EXCL = new RegExp(String.raw`(?:\+|\bplus\b|\bex(?:cl(?:uding|usive(?:\s+of)?)?)?\.?|\bbefore\b)\s*(${TAX_RUN})\b`, 'i');

function codeFor(run: string): string {
  const w = run.toUpperCase();
  if (w.includes('QST')) return 'GST_QST';
  if (w.includes('PST')) return 'GST_PST';
  if (w.includes('HST')) return 'HST';
  return 'GST';
}

export function parseTaxPhrase(text: string): TaxPhrase | null {
  if (!text) return null;
  const s = text.slice(0, 500);
  // Inclusive first: "incl GST+PST" carries a "+" that is not the exclusive "+ GST".
  const inc = INCL.exec(s);
  if (inc) return { taxCode: codeFor(inc[1] || inc[2]), taxInclusive: true };
  const ex = EXCL.exec(s);
  if (ex) return { taxCode: codeFor(ex[1]), taxInclusive: false };
  return null;
}

/** Adds the phrase's code to record-expense params (an extractor-set code wins). */
export function applyTaxPhrase(params: Record<string, unknown>, text: string): void {
  if (typeof params.taxCode === 'string' && params.taxCode) return;
  const p = parseTaxPhrase(text);
  if (!p) return;
  params.taxCode = p.taxCode;
  params.taxInclusive = p.taxInclusive;
  params.taxCodeIsHint = true;
}

/** "GST $10.00 claimable" for a created expense with a recoverable split; '' otherwise. */
export function taxSplitLine(
  data: { taxCode?: string | null; recoverableTaxCents?: number | null; [k: string]: unknown },
  t: (key: string, params?: Record<string, string | number>) => string,
  fmt: (cents: number) => string,
): string {
  const cents = data?.recoverableTaxCents ?? 0;
  if (!data?.taxCode || !(cents > 0)) return '';
  return t('skill.expense_tax_claimable', { label: data.taxCode.replace(/_/g, '/'), amount: fmt(cents) });
}
