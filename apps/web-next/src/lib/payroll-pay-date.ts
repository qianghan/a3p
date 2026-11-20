/**
 * PR 4d — statutory reports bucket pay runs by PAY DATE (owner call O1).
 *
 * STP, BAS W1/W2, year-end forms (W-2/T4/payment summary + PDFs) and
 * payroll-tax deposits follow the date the wages were paid. Legacy runs with
 * `payDate = null` keep their old bucket (`periodEnd`).
 *
 * The payroll JOURNAL deliberately stays on `periodEnd` (expense recognised
 * when earned) — never use these helpers for the journal date.
 */

export interface PayDated {
  payDate?: Date | null;
  periodEnd: Date;
}

/** The date a statutory report buckets this run under. */
export function statutoryPayDate(run: PayDated): Date {
  return run.payDate ?? run.periodEnd;
}

type DateRange = { gte?: Date; lt?: Date; lte?: Date };

/**
 * Prisma `where` fragment for AbPayRun: statutory date in range.
 * `payDate` in range, or (legacy) `payDate` null and `periodEnd` in range.
 */
export function payRunStatutoryDateWhere(range: DateRange): { OR: Array<Record<string, unknown>> } {
  return {
    OR: [
      { payDate: range },
      { payDate: null, periodEnd: range },
    ],
  };
}
