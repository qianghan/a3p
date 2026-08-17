/**
 * The tax year the plugin means by "the current filing year".
 *
 * One definition, shared by every surface in this plugin frontend, so the
 * Year-end Package tab and the Filing Review tab can never end up pointed at
 * different years for the same tenant — and matching defaultFilingYear() in
 * plugins/agentbook-core/backend/src/server.ts, which is what the chat path
 * uses when the user doesn't name a year.
 *
 * The prior calendar year: you file 2025's return during 2026. UTC, not
 * local time, so the answer doesn't flip depending on which side of midnight
 * on Jan 1 the page happens to load.
 */
export function currentFilingYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - 1;
}
