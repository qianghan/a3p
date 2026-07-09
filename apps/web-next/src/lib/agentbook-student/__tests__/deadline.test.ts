import { describe, it, expect } from 'vitest';
import { parseDeadline, isDeadlinePassed } from '../deadline';

describe('parseDeadline', () => {
  it('parses common real-date formats', () => {
    expect(parseDeadline('March 1, 2027')?.getFullYear()).toBe(2027);
    expect(parseDeadline('2027-03-01')?.getFullYear()).toBe(2027);
    expect(parseDeadline('3/1/2027')?.getFullYear()).toBe(2027);
  });

  it('parses a bare ISO date (YYYY-MM-DD) as the exact calendar date written, regardless of the runtime timezone', () => {
    // Plain `new Date('2027-03-01')` parses as UTC midnight per spec; reading
    // it back with local calendar-day getters (as isDeadlinePassed does)
    // would silently shift it to Feb 28 in any timezone behind UTC. This
    // exact regression was caught by self-review before merge.
    const d = parseDeadline('2027-03-01');
    expect(d?.getFullYear()).toBe(2027);
    expect(d?.getMonth()).toBe(2); // 0-indexed: March
    expect(d?.getDate()).toBe(1);
  });

  it('returns null for non-date free text — never treated as expired', () => {
    expect(parseDeadline('Rolling')).toBeNull();
    expect(parseDeadline('Ongoing')).toBeNull();
    expect(parseDeadline('Varies by program')).toBeNull();
    expect(parseDeadline('TBD')).toBeNull();
  });

  it('returns null for empty, whitespace-only, or missing input', () => {
    expect(parseDeadline('')).toBeNull();
    expect(parseDeadline('   ')).toBeNull();
    expect(parseDeadline(null)).toBeNull();
    expect(parseDeadline(undefined)).toBeNull();
  });
});

describe('isDeadlinePassed', () => {
  const now = new Date('2026-07-09T12:00:00Z');

  it('is true for a date clearly in the past', () => {
    expect(isDeadlinePassed(new Date('2026-01-01'), now)).toBe(true);
  });

  it('is false for a date in the future', () => {
    expect(isDeadlinePassed(new Date('2027-01-01'), now)).toBe(false);
  });

  it('is false for a deadline of exactly today — not expired until tomorrow', () => {
    expect(isDeadlinePassed(new Date('2026-07-09T23:00:00Z'), now)).toBe(false);
  });

  it('is false when the deadline is null (unparseable/not provided) — nothing to filter on', () => {
    expect(isDeadlinePassed(null, now)).toBe(false);
  });
});
