/** Pure payroll ledger split: from pay stubs → gross / net / withheld totals. */

export interface StubTotals {
  grossCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number;
  otherDeductCents: number;
  netCents: number;
}

export interface PayrollEntry {
  grossCents: number;
  netCents: number;
  withheldCents: number;
}

/**
 * Split a pay run into a balanced 3-line journal entry:
 *   Dr Salary Expense  = gross
 *   Cr Cash            = net (paid to employees)
 *   Cr Payroll Liab.   = withheld (remitted to authorities later)
 * Invariant: net + withheld === gross.
 */
export function splitPayrollEntry(stubs: StubTotals[]): PayrollEntry {
  let grossCents = 0;
  let netCents = 0;
  let withheldCents = 0;
  for (const s of stubs) {
    grossCents += s.grossCents;
    netCents += s.netCents;
    withheldCents += s.federalTaxCents + s.stateTaxCents + s.ficaCents + s.otherDeductCents;
  }
  return { grossCents, netCents, withheldCents };
}
