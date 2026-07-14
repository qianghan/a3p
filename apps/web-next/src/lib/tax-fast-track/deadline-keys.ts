// The "annual filing due" event is titled differently per jurisdiction
// pack — us/calendar-deadlines.ts uses calendar.annual_tax_filing_due,
// ca/calendar-deadlines.ts uses calendar.t1_filing_due (no
// annual_tax_filing_due key exists for CA at all). Fast-track only
// supports us/ca, so this two-entry list covers it — each key is already
// unambiguous to its own jurisdiction, no tenant ever has both. Shared
// between the /status route (deadline countdown) and the calendar-check
// cron (proactive nudge) so both call sites recognize the identical set.
export const ANNUAL_FILING_DEADLINE_KEYS = ['calendar.annual_tax_filing_due', 'calendar.t1_filing_due'];
