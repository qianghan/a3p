import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatDocDate } from '@/app/app/_lib/format';

// The default test zone is UTC on CI, where dropping `timeZone: 'UTC'` from
// formatDocDate changes nothing. Pin a zone WEST of Greenwich so the day shifts
// the moment the formatter falls back to the viewer's zone.
describe('formatDocDate under a western zone', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('the pinned zone is really in effect (guards this file against being vacuous)', () => {
    // A local-zone render of UTC midnight lands on the previous day.
    expect(new Date('2026-10-01T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric' })).toBe('Sep 30');
  });

  it('a date-only ISO is a calendar date: it never shifts to the previous day', () => {
    expect(formatDocDate('2026-10-01', 'en')).toBe('Oct 1, 2026');
  });

  it('a UTC-midnight timestamp (how expense dates are stored) shows the same calendar day', () => {
    expect(formatDocDate('2026-10-01T00:00:00.000Z', 'en')).toBe('Oct 1, 2026');
  });
});
