/**
 * The Australian income year (1 Jul – 30 Jun).
 *
 * A leaf module on purpose: mileage, STP and BAS all need these two functions,
 * and importing them from a payroll module would drag the whole pay-event
 * graph into an expense route. This package has already shipped one ESM import
 * cycle that silently broke a shipping path — keep the shared primitives at
 * the leaves.
 */

/**
 * The AU financial year (starting 1 Jul) that a given date falls in, expressed
 * as the ending calendar year — e.g. 2026-03-15 → FY2025-26 → 2026; a date in
 * Aug 2025 → FY2025-26 → 2026.
 */
export function auFinancialYearOf(date: Date): number {
  // Jul (month 6) onward belongs to the FY ending the NEXT calendar year.
  return date.getUTCMonth() >= 6 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

/** Start date (1 Jul) of the AU financial year ending in `financialYear`. */
export function auFinancialYearStart(financialYear: number): Date {
  return new Date(Date.UTC(financialYear - 1, 6, 1)); // 1 Jul of the prior calendar year
}
