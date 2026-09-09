/**
 * Single Touch Payroll (STP Phase 2) pay-event builder — Australia.
 *
 * On each pay run, an AU employer must report to the ATO, per employee, the
 * YEAR-TO-DATE (financial year, 1 Jul–30 Jun) gross, PAYG withholding, and
 * superannuation, plus employer totals. This builds that pay-event payload
 * from the tenant's own pay-stub data — a pure aggregation, no re-derivation.
 *
 * It produces the DATA STRUCTURE + an export-ready shape; it does NOT transmit.
 * Real lodgment goes over SBR2/AS4 and requires ATO software-provider
 * accreditation (a Wave-3 activation step — launch guide §7.1). `lodgment`
 * therefore stays 'prepared' here; a transport layer flips it to 'lodged'
 * once accredited.
 *
 * DB-free + unit-testable; the pay-stub query + jurisdiction gate live in the
 * route. Maps AgentBook payroll fields to STP concepts: grossCents → gross,
 * federalTaxCents → PAYG withholding, sgCents → superannuation guarantee.
 */

export interface StpPayeeYtd {
  employeeId: string;
  name: string;
  ytdGrossCents: number;
  ytdPaygWithheldCents: number;
  ytdSuperCents: number;
}

export interface StpPayEventInput {
  /** AU financial year the YTD figures roll up into, e.g. 2026 for FY2025-26. */
  financialYear: number;
  /** The pay run this event reports (its period end is the event date). */
  periodStart: string; // ISO
  periodEnd: string; // ISO
  payees: StpPayeeYtd[];
}

export interface StpPayEvent {
  financialYear: number;
  period: { start: string; end: string };
  payees: StpPayeeYtd[];
  employerTotals: {
    ytdGrossCents: number;
    ytdPaygWithheldCents: number;
    ytdSuperCents: number;
    payeeCount: number;
  };
  /** 'prepared' until an accredited SBR transport lodges it (guide §7.1). */
  lodgment: 'prepared' | 'lodged';
}

export function buildStpPayEvent(input: StpPayEventInput): StpPayEvent {
  const employerTotals = input.payees.reduce(
    (t, p) => ({
      ytdGrossCents: t.ytdGrossCents + p.ytdGrossCents,
      ytdPaygWithheldCents: t.ytdPaygWithheldCents + p.ytdPaygWithheldCents,
      ytdSuperCents: t.ytdSuperCents + p.ytdSuperCents,
      payeeCount: t.payeeCount + 1,
    }),
    { ytdGrossCents: 0, ytdPaygWithheldCents: 0, ytdSuperCents: 0, payeeCount: 0 },
  );
  return {
    financialYear: input.financialYear,
    period: { start: input.periodStart, end: input.periodEnd },
    payees: input.payees,
    employerTotals,
    lodgment: 'prepared',
  };
}

// The income-year helpers live in a leaf module so an expense route can use
// them without importing this one. Re-exported here for existing callers.
export { auFinancialYearOf, auFinancialYearStart } from './financial-year.js';
