/**
 * The tax year whose published tables the bracket + self-employment-tax data
 * currently reflects. The packs are NOT yet year-versioned — every
 * tax-brackets.ts carries a `// TODO: year-versioned lookup` and returns the
 * same 2025 tables regardless of the requested year.
 *
 * Rather than fabricate later-year figures, we surface which tables were used so
 * the UI can disclose it honestly ("2025 tables") instead of implying the
 * estimate reflects the requested year's law. When verified 2026+ tables are
 * loaded, bump this and make the providers year-aware.
 */
export const MODELED_TAX_YEAR = 2025;

export interface TaxYearDisclosure {
  tablesYear: number;
  usesRequestedYearTables: boolean;
  note: string | null;
}

/** Describe, for a requested tax year, which tables were actually applied. */
export function taxYearDisclosure(requestedYear: number): TaxYearDisclosure {
  const usesRequestedYearTables = requestedYear === MODELED_TAX_YEAR;
  return {
    tablesYear: MODELED_TAX_YEAR,
    usesRequestedYearTables,
    note: usesRequestedYearTables
      ? null
      : `This estimate uses ${MODELED_TAX_YEAR} tax tables — ${requestedYear} figures aren't loaded yet, so treat it as an approximation for ${requestedYear} and verify against current-year rates before filing.`,
  };
}
