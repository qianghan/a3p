import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  tenantLocalDateToUtc,
  tenantPeriodKey,
  tenantLocalDateKey,
} from '../agentbook-tenant-tz';

describe('tenantLocalDateToUtc (G-025)', () => {
  it('UTC tenant: "2026-03-31" → 2026-03-31T00:00:00Z', () => {
    const d = tenantLocalDateToUtc('2026-03-31', 'UTC');
    expect(d.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('New York tenant (UTC-4 EDT): "2026-03-31" → 2026-03-31T04:00:00Z', () => {
    // Mar 31 2026 is during EDT (DST active), UTC-4.
    const d = tenantLocalDateToUtc('2026-03-31', 'America/New_York');
    expect(d.toISOString()).toBe('2026-03-31T04:00:00.000Z');
  });

  it('Tokyo tenant (UTC+9): "2026-03-31" → 2026-03-30T15:00:00Z', () => {
    // Midnight Tokyo = 3pm UTC the prior day.
    const d = tenantLocalDateToUtc('2026-03-31', 'Asia/Tokyo');
    expect(d.toISOString()).toBe('2026-03-30T15:00:00.000Z');
  });

  it('Tokyo wall-clock "2026-03-31T23:00:00" stays in March in Tokyo (Apr 1 in UTC)', () => {
    const d = tenantLocalDateToUtc('2026-03-31T23:00:00', 'Asia/Tokyo');
    // 23:00 Tokyo = 14:00 UTC same date
    expect(d.toISOString()).toBe('2026-03-31T14:00:00.000Z');
    // But what month is this in the tenant's calendar? March.
    expect(tenantPeriodKey(d, 'Asia/Tokyo')).toBe('2026-03');
  });

  it('London tenant during BST (UTC+1): "2026-06-15" → 2026-06-14T23:00:00Z', () => {
    const d = tenantLocalDateToUtc('2026-06-15', 'Europe/London');
    expect(d.toISOString()).toBe('2026-06-14T23:00:00.000Z');
  });

  it('absolute ISO with Z passes through unchanged', () => {
    const d = tenantLocalDateToUtc('2026-03-31T12:00:00Z', 'Asia/Tokyo');
    expect(d.toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('Date input passes through unchanged', () => {
    const input = new Date('2026-03-31T05:00:00Z');
    const d = tenantLocalDateToUtc(input, 'America/New_York');
    expect(d.getTime()).toBe(input.getTime());
  });

  it('invalid timezone falls back to UTC (no throw)', () => {
    const d = tenantLocalDateToUtc('2026-03-31', 'Not/AReal_Zone');
    expect(d.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});

describe('tenantPeriodKey (G-025)', () => {
  it('groups by tenant-local month — the audit bug', () => {
    // Asia/Tokyo, posted at 23:00 local on Mar 31. UTC says Apr 1, but
    // tenant period must be 2026-03.
    const utc = new Date('2026-03-31T14:00:00Z'); // = 23:00 Tokyo Mar 31
    expect(tenantPeriodKey(utc, 'Asia/Tokyo')).toBe('2026-03');
    // Same UTC instant in NY → 10am Mar 31 → also '2026-03'
    expect(tenantPeriodKey(utc, 'America/New_York')).toBe('2026-03');
  });

  it('handles the inverse: UTC says March, tenant says April', () => {
    // 1am UTC Apr 1 = 10am Tokyo Apr 1 → '2026-04'
    const utc = new Date('2026-04-01T01:00:00Z');
    expect(tenantPeriodKey(utc, 'Asia/Tokyo')).toBe('2026-04');
    // Same UTC moment in LA → 9pm Mar 31 → '2026-03'
    expect(tenantPeriodKey(utc, 'America/Los_Angeles')).toBe('2026-03');
  });
});

describe('tenantLocalDateKey (G-025)', () => {
  it('returns YYYY-MM-DD in tenant local', () => {
    const utc = new Date('2026-03-31T22:00:00Z');
    expect(tenantLocalDateKey(utc, 'UTC')).toBe('2026-03-31');
    // 22:00 UTC = 18:00 NY (EDT) → still Mar 31
    expect(tenantLocalDateKey(utc, 'America/New_York')).toBe('2026-03-31');
    // 22:00 UTC = 07:00 Tokyo (next day) → Apr 1
    expect(tenantLocalDateKey(utc, 'Asia/Tokyo')).toBe('2026-04-01');
  });
});

describe('DST boundary handling', () => {
  it('Spring-forward: 2:30am DST gap in NY does not infinite-loop or crash', () => {
    // March 9 2026 02:00 EST → DST starts, clocks jump to 03:00. The
    // wall-clock 02:30 doesn't exist. Implementation must not throw.
    const d = tenantLocalDateToUtc('2026-03-08T02:30:00', 'America/New_York');
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBeGreaterThan(0);
  });

  it('Fall-back: 1:30am EDT/EST ambiguity resolves to one branch (no crash)', () => {
    // Nov 1 2026 02:00 EDT → clocks fall back to 01:00 EST. 01:30 happens
    // twice. Implementation should pick one consistently.
    const d = tenantLocalDateToUtc('2026-11-01T01:30:00', 'America/New_York');
    expect(d).toBeInstanceOf(Date);
  });
});
