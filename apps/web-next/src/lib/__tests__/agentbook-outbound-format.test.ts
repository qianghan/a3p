/**
 * Outbound money and date formatting.
 *
 * These formatters feed Telegram replies, the morning digest and invoice
 * emails. A wrong figure there is worse than a wrong label in the app: the
 * message is read outside the product, often on a phone, with no surrounding UI
 * to correct the impression and no language switcher to try.
 *
 * Every assertion is on OUTPUT, and each names the exact string the old
 * hardcoded-'en-US' code produced — so a regression fails for the right reason
 * rather than on incidental drift.
 */
import { describe, it, expect, vi } from 'vitest';

// Same pattern as agentbook-tenant-tz.test.ts: the module under test declares
// `import 'server-only'`, which throws outside a Server Component.
vi.mock('server-only', () => ({}));

import {
  resolveOutboundLocale,
  outMoney,
  outMoneyCompact,
  outDate,
  outNumber,
  OUTBOUND_FALLBACK,
  type OutboundLocale,
} from '../agentbook-outbound-format';

const EN: OutboundLocale = { locale: 'en-US', currency: 'USD', timezone: 'America/New_York' };
const FR: OutboundLocale = { locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto' };
const ZH: OutboundLocale = { locale: 'zh-CN', currency: 'CNY', timezone: 'Asia/Shanghai' };

describe('outMoney', () => {
  it('renders US format for an en-US tenant', () => {
    expect(outMoney(123456, EN)).toBe('$1,234.56');
  });

  it('renders French-Canadian format — the regression', () => {
    const out = outMoney(123456, FR);
    // Exactly what the old code sent a Quebec user.
    expect(out).not.toBe('$1,234.56');
    // Comma decimal, symbol trailing, non-breaking space as the group
    // separator (hence \s rather than a literal space).
    expect(out).toMatch(/1\s*234,56\s*\$/);
  });

  it('renders Chinese format', () => {
    expect(outMoney(123456, ZH)).toMatch(/¥1,234\.56/);
  });

  it('an explicit currency overrides the tenant default and is NOT relabelled', () => {
    // A EUR invoice raised by a CAD tenant is a EUR invoice. Silently showing
    // it as CAD would misstate what the client owes.
    const out = outMoney(123456, FR, 'EUR');
    expect(out).toContain('€');
    expect(out).not.toContain('$');
  });

  it('an unknown currency degrades to a labelled amount, not a bare number', () => {
    // Intl throws on a bad code. "XYZ 1234.56" is unambiguous; "1234.56" is
    // a figure with no unit, which is worse than an ugly one.
    const out = outMoney(123456, EN, 'NOTACURRENCY');
    expect(out).toContain('NOTACURRENCY');
    expect(out).toContain('1234.56');
  });

  it('handles negative amounts', () => {
    expect(outMoney(-5000, EN)).toContain('50.00');
  });
});

describe('outMoneyCompact', () => {
  it('drops the cents on a whole amount', () => {
    expect(outMoneyCompact(500000, EN)).toBe('$5,000');
  });

  it('keeps the cents when there are any', () => {
    expect(outMoneyCompact(500050, EN)).toBe('$5,000.50');
  });

  it('still follows the locale', () => {
    expect(outMoneyCompact(500000, FR)).not.toBe('$5,000');
  });
});

describe('outDate', () => {
  it('renders the tenant timezone, not UTC — the day-early bug', () => {
    // 2026-03-22T02:00Z is still Mar 21 in New York. A due date rendered a day
    // early is a material error, and this is the shape that produced it.
    const out = outDate('2026-03-22T02:00:00.000Z', EN);
    expect(out).toContain('21');
    expect(out).not.toContain('22');
  });

  it('the same instant renders differently in a different tenant zone', () => {
    const ny = outDate('2026-03-22T02:00:00.000Z', EN);
    const sh = outDate('2026-03-22T02:00:00.000Z', ZH);
    // Shanghai is already Mar 22 at that instant.
    expect(sh).not.toBe(ny);
  });

  it('renders French month names', () => {
    const out = outDate('2026-03-22T12:00:00.000Z', FR);
    expect(out).toMatch(/mars/);
    expect(out).not.toMatch(/Mar\b/);
  });

  it('falls back to an ISO date on a bad timezone rather than throwing', () => {
    const out = outDate('2026-03-22T12:00:00.000Z', { ...EN, timezone: 'Not/AZone' });
    expect(out).toBe('2026-03-22');
  });
});

describe('outNumber', () => {
  it('follows the locale separator', () => {
    expect(outNumber(1234.5, EN)).toBe('1,234.5');
    expect(outNumber(1234.5, FR)).not.toBe('1,234.5');
  });
});

describe('resolveOutboundLocale', () => {
  it('reads locale, currency and timezone from a config row', () => {
    expect(resolveOutboundLocale({
      locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto',
    })).toEqual({ locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto' });
  });

  it('falls back when the tenant has no config row', () => {
    expect(resolveOutboundLocale(null)).toEqual(OUTBOUND_FALLBACK);
    expect(resolveOutboundLocale(undefined)).toEqual(OUTBOUND_FALLBACK);
  });

  it('treats an empty-string column as absent', () => {
    // A blank column is not a locale. Passing '' to Intl throws, so this is the
    // difference between a formatted figure and a crashed digest.
    expect(resolveOutboundLocale({ locale: '', currency: '', timezone: '' }))
      .toEqual(OUTBOUND_FALLBACK);
  });

  it('fills only the missing fields', () => {
    expect(resolveOutboundLocale({ locale: 'zh-CN' })).toEqual({
      locale: 'zh-CN',
      currency: OUTBOUND_FALLBACK.currency,
      timezone: OUTBOUND_FALLBACK.timezone,
    });
  });
});
