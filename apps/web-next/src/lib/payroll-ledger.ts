/** Pure payroll ledger split: from pay stubs → gross / net / withheld totals. */

export interface StubTotals {
  grossCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number;
  otherDeductCents: number;
  netCents: number;
  sgCents?: number; // Superannuation Guarantee (AU) — optional, defaults to 0
}

export interface PayrollEntry {
  grossCents: number;
  netCents: number;
  withheldCents: number;
  sgCents: number;
}

/**
 * Split a pay run into a balanced journal entry:
 *   Dr Salary Expense       = gross
 *   Dr Superannuation Exp.  = sg (additional employer cost, on top of gross)
 *   Cr Cash                 = net (paid to employees)
 *   Cr Payroll Liab.        = withheld (remitted to authorities later)
 *   Cr Superannuation Pay.  = sg (remitted to super funds later)
 * Invariant: net + withheld === gross (sg is a separate, self-balancing pair
 * that doesn't affect this invariant since it's debited and credited equally).
 */
export function splitPayrollEntry(stubs: StubTotals[]): PayrollEntry {
  let grossCents = 0;
  let netCents = 0;
  let withheldCents = 0;
  let sgCents = 0;
  for (const s of stubs) {
    grossCents += s.grossCents;
    netCents += s.netCents;
    withheldCents += s.federalTaxCents + s.stateTaxCents + s.ficaCents + s.otherDeductCents;
    sgCents += s.sgCents ?? 0;
  }
  return { grossCents, netCents, withheldCents, sgCents };
}
