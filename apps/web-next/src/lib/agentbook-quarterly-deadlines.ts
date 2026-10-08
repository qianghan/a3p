/**
 * Estimated-tax instalment deadlines per jurisdiction. Moved verbatim from
 * app/api/v1/agentbook-tax/tax/quarterly/route.ts so the mobile "next up"
 * list (lib/mobile/upcoming.ts) uses the same dates the Tax page does.
 */
export interface QuarterlyDeadline {
  quarter: number;
  deadline: Date;
}

export function getQuarterlyDeadlines(year: number, jurisdiction: string): QuarterlyDeadline[] {
  if (jurisdiction === 'ca') {
    return [
      { quarter: 1, deadline: new Date(`${year}-03-15`) },
      { quarter: 2, deadline: new Date(`${year}-06-15`) },
      { quarter: 3, deadline: new Date(`${year}-09-15`) },
      { quarter: 4, deadline: new Date(`${year}-12-15`) },
    ];
  }
  if (jurisdiction === 'au') {
    // Australian financial year runs July-June; these are the ATO PAYG
    // instalment dates (same dates as packages/agentbook-jurisdictions's
    // au/calendar-deadlines.ts's payg_qN_instalment entries).
    return [
      { quarter: 1, deadline: new Date(`${year}-10-28`) },
      { quarter: 2, deadline: new Date(`${year + 1}-02-28`) },
      { quarter: 3, deadline: new Date(`${year + 1}-04-28`) },
      { quarter: 4, deadline: new Date(`${year + 1}-07-28`) },
    ];
  }
  return [
    { quarter: 1, deadline: new Date(`${year}-04-15`) },
    { quarter: 2, deadline: new Date(`${year}-06-15`) },
    { quarter: 3, deadline: new Date(`${year}-09-15`) },
    { quarter: 4, deadline: new Date(`${year + 1}-01-15`) },
  ];
}
