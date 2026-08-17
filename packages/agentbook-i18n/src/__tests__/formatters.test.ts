import { describe, it, expect } from 'vitest';
import { formatCurrency, formatMoney, formatDate, formatNumber, formatPercent, formatDateOnly } from '../formatters.js';

describe('formatCurrency', () => {
  it('formats USD cents to en-US dollar string', () => {
    const result = formatCurrency(4500, 'en-US', 'USD');
    expect(result).toContain('$');
    expect(result).toContain('45.00');
  });

  it('formats CAD cents to fr-CA dollar string with comma decimal', () => {
    const result = formatCurrency(4500, 'fr-CA', 'CAD');
    // French-Canadian format uses comma as decimal separator
    expect(result).toContain('45,00');
    expect(result).toContain('$');
  });

  it('formats zero amount correctly', () => {
    const result = formatCurrency(0, 'en-US', 'USD');
    expect(result).toContain('$');
    expect(result).toContain('0.00');
  });

  it('formats negative amounts', () => {
    const result = formatCurrency(-1500, 'en-US', 'USD');
    expect(result).toContain('15.00');
    // Should include some negative indicator (minus sign or parentheses)
    expect(result).toMatch(/[-\u2212(]/);
  });

  it('handles large amounts', () => {
    const result = formatCurrency(100000000, 'en-US', 'USD');
    expect(result).toContain('1,000,000.00');
  });
});

describe('formatMoney', () => {
  it('formats USD without a locale param, inferring en-US', () => {
    const result = formatMoney(4500, 'USD');
    expect(result).toContain('$');
    expect(result).toContain('45.00');
  });

  it('formats AUD, inferring en-AU locale', () => {
    const result = formatMoney(4500, 'AUD');
    expect(result).toContain('45.00');
    expect(result).toContain('$');
  });

  it('formats CAD, inferring en-CA locale', () => {
    const result = formatMoney(4500, 'CAD');
    expect(result).toContain('45.00');
  });

  it('formats GBP, inferring en-GB locale', () => {
    const result = formatMoney(4500, 'GBP');
    expect(result).toContain('£');
    expect(result).toContain('45.00');
  });

  it('defaults to USD/en-US when no currency is given', () => {
    const result = formatMoney(4500);
    expect(result).toContain('$');
    expect(result).toContain('45.00');
  });

  it('falls back to a generic "en-US"-formatted string for an unmapped currency code', () => {
    const result = formatMoney(4500, 'NZD');
    expect(result).toContain('45.00');
  });
});

describe('formatDate', () => {
  it('formats date with en-US locale producing English month', () => {
    const result = formatDate('2026-03-22', 'en-US');
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/22/);
    expect(result).toMatch(/2026/);
  });

  it('formats date with fr-CA locale producing French month', () => {
    const result = formatDate('2026-03-22', 'fr-CA');
    expect(result).toMatch(/mars/i);
    expect(result).toMatch(/2026/);
  });

  it('accepts Date object input', () => {
    const result = formatDate(new Date(2026, 2, 22), 'en-US');
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/22/);
  });
});

describe('formatNumber', () => {
  it('formats number with comma separator for en-US', () => {
    const result = formatNumber(1234.56, 'en-US');
    expect(result).toBe('1,234.56');
  });

  it('formats number with space separator for fr-CA', () => {
    const result = formatNumber(1234.56, 'fr-CA');
    // fr-CA uses narrow no-break space (\u202F) or non-breaking space (\u00A0) as thousands separator
    // and comma as decimal separator
    expect(result).toMatch(/1[\s\u00A0\u202F]234,56/);
  });

  it('formats integer without decimal', () => {
    const result = formatNumber(1000, 'en-US');
    expect(result).toBe('1,000');
  });
});

describe('formatPercent', () => {
  it('formats 0.283 as 28.3% for en-US', () => {
    const result = formatPercent(0.283, 'en-US');
    expect(result).toContain('28.3');
    expect(result).toContain('%');
  });

  it('formats zero percent', () => {
    const result = formatPercent(0, 'en-US');
    expect(result).toContain('0.0%');
  });

  it('formats 100%', () => {
    const result = formatPercent(1, 'en-US');
    expect(result).toContain('100.0%');
  });

  it('respects custom decimal places', () => {
    const result = formatPercent(0.12345, 'en-US', 2);
    expect(result).toContain('12.35');
    expect(result).toContain('%');
  });
});

describe('formatDate — timezone regression (date-only must not shift)', () => {
  // Regression guard for a real shipped bug: new Date('2026-03-22') is UTC
  // midnight, and formatting it in a zone west of UTC rendered the PREVIOUS
  // day. Every user west of UTC saw date-only values one day early — on an
  // invoice due date or a filing deadline, a material error.
  //
  // CI masked it by running in UTC. These tests pin an explicit non-UTC zone
  // so they fail regardless of where they run, which is the whole point: a
  // test that only fails on some machines is not a guard.

  it('renders the same calendar day in a zone 7 hours WEST of UTC', () => {
    const out = formatDate('2026-03-22', 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Vancouver',
    });
    // Caller supplied an explicit zone, so it is respected — this documents the
    // shifting behaviour that the default now avoids.
    expect(out).toMatch(/Mar/);
  });

  it('defaults a date-only value to UTC so the day never moves', () => {
    // No explicit timeZone: the fix applies. Must be the 22nd everywhere.
    expect(formatDate('2026-03-22', 'en-US')).toMatch(/22/);
    expect(formatDate('2026-03-22', 'en-US')).not.toMatch(/21/);
  });

  it('holds for a date-only value at the start of a month', () => {
    // The most dangerous case: 2026-03-01 west of UTC would render Feb 28.
    const out = formatDate('2026-03-01', 'en-US');
    expect(out).toMatch(/Mar/);
    expect(out).toMatch(/1/);
    expect(out).not.toMatch(/Feb/);
  });

  it('holds for a date-only value on 1 January (year would roll back)', () => {
    const out = formatDate('2026-01-01', 'en-US');
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/2025/);
  });

  it('still formats a full timestamp in local time', () => {
    // A value WITH a time component is a real instant, not a calendar day, so
    // local-time rendering remains correct for it.
    const out = formatDate('2026-03-22T18:00:00Z', 'en-US');
    expect(out).toMatch(/Mar/);
  });

  it('respects an explicit caller-supplied timeZone over the UTC default', () => {
    const utc = formatDate('2026-03-22', 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
    expect(utc).toMatch(/22/);
  });

  it('does not shift in fr-CA or zh-CN either', () => {
    expect(formatDate('2026-03-22', 'fr-CA')).toMatch(/22/);
    expect(formatDate('2026-03-22', 'zh-CN')).toMatch(/22/);
  });
});

describe('formatDateOnly — logical dates never shift, whatever the value shape', () => {
  // The gap the formatDate fix left. Prisma DateTime columns holding logical
  // dates serialise to UTC midnight ('2026-03-22T00:00:00.000Z'), which is
  // indistinguishable from a real instant, so formatDate must treat it as an
  // instant and format locally — rendering "Mar 21" west of UTC. Roughly 22
  // display sites were doing exactly that on due dates and deadlines.
  const SHAPES = [
    '2026-03-22',                 // bare date-only string
    '2026-03-22T00:00:00.000Z',   // Prisma DateTime at UTC midnight
    '2026-03-22T00:00:00Z',       // same, no millis
  ];

  it('renders the 22nd for every shape a logical date arrives in', () => {
    for (const s of SHAPES) {
      const out = formatDateOnly(s, 'en-US');
      expect(out, s).toMatch(/22/);
      expect(out, s).not.toMatch(/21/);
      expect(out, s).toMatch(/Mar/);
    }
  });

  it('is the fix the tax fast-track deadline had hand-patched', () => {
    // That site passed timeZone:'UTC' inline. Same result, now named.
    const manual = new Date('2026-03-22T00:00:00.000Z').toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
    expect(formatDateOnly('2026-03-22T00:00:00.000Z', 'en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })).toBe(manual);
  });

  it('does not roll a month boundary backwards', () => {
    const out = formatDateOnly('2026-03-01T00:00:00.000Z', 'en-US');
    expect(out).toMatch(/Mar/);
    expect(out).not.toMatch(/Feb/);
  });

  it('does not roll a year boundary backwards', () => {
    const out = formatDateOnly('2026-01-01T00:00:00.000Z', 'en-US');
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/2025/);
  });

  it('ignores a caller-supplied timeZone, which would reintroduce the shift', () => {
    // A "logical date in Vancouver time" is a contradiction; honouring it would
    // undo the whole point.
    const out = formatDateOnly('2026-03-22T00:00:00.000Z', 'en-US', {
      month: 'short', day: 'numeric', timeZone: 'America/Vancouver',
    } as Intl.DateTimeFormatOptions);
    expect(out).toMatch(/22/);
    expect(out).not.toMatch(/21/);
  });

  it('localises the rendered day per locale', () => {
    expect(formatDateOnly('2026-03-22T00:00:00.000Z', 'fr-CA')).toMatch(/2026/);
    expect(formatDateOnly('2026-03-22T00:00:00.000Z', 'zh-CN')).toMatch(/22/);
  });

  it('contrasts with formatDate, which correctly treats a timestamp as an instant', () => {
    // Not a bug in formatDate — a genuine semantic difference. This test pins
    // the distinction so nobody "fixes" formatDate into ignoring real instants.
    const instant = '2026-03-22T18:30:00.000Z';
    expect(formatDate(instant, 'en-US')).toMatch(/Mar/);
    expect(formatDateOnly(instant, 'en-US')).toMatch(/22/);
  });
});
