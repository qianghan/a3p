/**
 * One deductible figure (PR 2b, spec §5.1).
 *
 * Registrant expenses store `amountCents` = document gross and
 * `recoverableTaxCents` = the input-tax credit (GST/HST/PST-recoverable).
 * The journal posts DR category (gross − recoverable), so every TABLE reader
 * that totals AbExpense for deductions / categories / vendors must use this
 * figure or it over-deducts versus the P&L. Untyped/legacy rows have
 * recoverableTaxCents null/0 → deductible == gross.
 *
 * NOT for cash-flow, bank matching, receipt totals or payments: those are gross.
 */
export interface ExpenseAmountFields {
  amountCents: number | null;
  recoverableTaxCents?: number | null;
}

export function deductibleCents(e: ExpenseAmountFields): number {
  return (e.amountCents ?? 0) - (e.recoverableTaxCents ?? 0);
}

/** Sum rows, or a prisma `_sum` aggregate ({amountCents, recoverableTaxCents}). */
export function sumDeductibleCents(rows: ExpenseAmountFields | ExpenseAmountFields[]): number {
  return Array.isArray(rows) ? rows.reduce((s, r) => s + deductibleCents(r), 0) : deductibleCents(rows);
}
