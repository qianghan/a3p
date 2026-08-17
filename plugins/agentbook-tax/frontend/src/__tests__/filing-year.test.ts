import { describe, it, expect } from 'vitest';
import { currentFilingYear } from '../lib/filing-year';

/**
 * One definition of "the current filing year", shared by the Year-end Package
 * tab and the Filing Review tab — and matching defaultFilingYear() in
 * plugins/agentbook-core/backend/src/server.ts, which is what the chat path
 * uses when the user doesn't name a year.
 *
 * The review tab and the chat path used to resolve this differently (the tab
 * computed the prior year; chat had a hardcoded `|| 2025`). Same tenant, two
 * surfaces, two different filings — and a submit gate that could never see a
 * confirmed review for the year being submitted.
 */
describe('currentFilingYear', () => {
  it('is the prior calendar year — you file 2025\'s return during 2026', () => {
    expect(currentFilingYear(new Date('2026-06-15T00:00:00Z'))).toBe(2025);
  });

  it('uses UTC, so it does not flip across midnight on New Year\'s Eve', () => {
    // 2026-12-31T23:30Z is 2026-12-31 18:30 in New York and 2027-01-01 10:30
    // in Sydney. A local-time implementation would disagree with itself.
    expect(currentFilingYear(new Date('2026-12-31T23:30:00Z'))).toBe(2025);
    expect(currentFilingYear(new Date('2027-01-01T00:30:00Z'))).toBe(2026);
  });

  it('defaults to now when called with no argument', () => {
    expect(currentFilingYear()).toBe(new Date().getUTCFullYear() - 1);
  });
});
