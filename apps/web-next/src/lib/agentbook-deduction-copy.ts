/**
 * User-facing prose for deduction suggestions.
 *
 * Separate from agentbook-deduction-rules.ts, which is `server-only` because
 * it touches the database. These are pure string helpers with no server
 * dependency, and keeping them here is what makes them testable — the reason
 * the jurisdiction bug below shipped is that the copy lived inside a module a
 * unit test could not import.
 */

/**
 * The business-meal limit, named for the tenant's own tax authority.
 *
 * The meal rule hardcoded "(50% in the US)", so a Canadian consultant was told
 * the IRS rule for her CRA return — found on production, 2026-07-31. The
 * percentage happens to be 50 in both, which is precisely why it went
 * unnoticed: the number was right and the authority was wrong. A user who
 * spots that has no reason to trust the rest of the advice.
 *
 * A note about the LIMIT only. Whether a given meal qualifies is the user's
 * call — this engine never auto-applies.
 */
export function mealDeductionNote(jurisdiction: 'us' | 'ca'): string {
  return jurisdiction === 'ca'
    ? 'business meals are typically 50% deductible under the CRA limit on food, beverages and entertainment.'
    : 'business meals are typically 50% deductible under the IRS limit.';
}
