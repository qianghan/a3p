/**
 * Money and date INPUT parsing.
 *
 * These tests encode two bugs that localising output alone would create or
 * leave in place. Both are money/date correctness issues, not cosmetics.
 *
 * BUG 1 — decimal comma, a 100x error
 *   14 call sites parse amounts as parseFloat(raw.replace(/,/g, '')): strip
 *   every comma, then parse. In Canadian French the decimal separator IS a
 *   comma, so "45,50" becomes parseFloat("4550") = 4550, then
 *   Math.round(4550 * 100) = 455000 cents = $4,550.00 instead of $45.50.
 *   Latent today only because no French UI exists. The moment the app renders
 *   "45,50 $" it is teaching users to type a format it misreads by 100x, and
 *   the wrong figure is booked straight to the double-entry ledger.
 *
 * BUG 2 — genuine ambiguity that no parser can resolve alone
 *   "1,500" is one thousand five hundred in en-US and one-and-a-half in fr-CA.
 *   Guessing wrong is a 1000x error. The parser must therefore REPORT
 *   ambiguity so the caller can echo the interpreted amount back for
 *   confirmation, rather than silently picking one.
 */
import { describe, it, expect } from 'vitest';
import { parseAmountToCents, parseDateInput } from '../parse.js';

describe('parseAmountToCents — en-US', () => {
  it('parses a plain decimal', () => {
    expect(parseAmountToCents('45.50', 'en-US').cents).toBe(4550);
  });

  it('treats comma as a thousands separator', () => {
    expect(parseAmountToCents('1,500', 'en-US').cents).toBe(150000);
    expect(parseAmountToCents('1,500.75', 'en-US').cents).toBe(150075);
    expect(parseAmountToCents('1,234,567.89', 'en-US').cents).toBe(123456789);
  });

  it('ignores currency symbols and whitespace', () => {
    expect(parseAmountToCents('$45.50', 'en-US').cents).toBe(4550);
    expect(parseAmountToCents('  45.50  ', 'en-US').cents).toBe(4550);
    expect(parseAmountToCents('USD 45.50', 'en-US').cents).toBe(4550);
  });

  it('rounds to the nearest cent rather than truncating', () => {
    expect(parseAmountToCents('45.005', 'en-US').cents).toBe(4501);
    expect(parseAmountToCents('45.004', 'en-US').cents).toBe(4500);
  });

  it('handles negatives', () => {
    expect(parseAmountToCents('-45.50', 'en-US').cents).toBe(-4550);
    expect(parseAmountToCents('($45.50)', 'en-US').cents).toBe(-4550);
  });
});

describe('parseAmountToCents — fr-CA (the 100x bug)', () => {
  it('reads comma as the DECIMAL separator', () => {
    // The regression this module exists to prevent. The old code produced
    // 455000 cents here.
    expect(parseAmountToCents('45,50', 'fr-CA').cents).toBe(4550);
    expect(parseAmountToCents('45,50', 'fr-CA').cents).not.toBe(455000);
  });

  it('reads space and non-breaking space as thousands separators', () => {
    // Intl formats fr-CA thousands with a narrow no-break space (U+202F) or
    // no-break space (U+00A0), which is what round-tripping our own output
    // will feed back in.
    expect(parseAmountToCents('1 500,75', 'fr-CA').cents).toBe(150075);
    expect(parseAmountToCents('1 500,75', 'fr-CA').cents).toBe(150075);
    expect(parseAmountToCents('1 500,75', 'fr-CA').cents).toBe(150075);
  });

  it('parses our own formatted output', () => {
    expect(parseAmountToCents('45,00 $', 'fr-CA').cents).toBe(4500);
  });

  it('still accepts a period-decimal, since users type both', () => {
    // A fr-CA user with a US keyboard habit types "45.50". Rejecting it would
    // be hostile; there is no ambiguity when only one separator is present and
    // it has 2 trailing digits.
    expect(parseAmountToCents('45.50', 'fr-CA').cents).toBe(4550);
  });
});

describe('parseAmountToCents — zh-CN', () => {
  it('uses period as decimal, comma as thousands, like en-US', () => {
    expect(parseAmountToCents('45.50', 'zh-CN').cents).toBe(4550);
    expect(parseAmountToCents('1,500.75', 'zh-CN').cents).toBe(150075);
  });

  it('ignores the CJK yuan symbol', () => {
    expect(parseAmountToCents('￥45.50', 'zh-CN').cents).toBe(4550);
    expect(parseAmountToCents('¥45.50', 'zh-CN').cents).toBe(4550);
  });
});

describe('parseAmountToCents — ambiguity reporting (decision D6)', () => {
  it('flags "1,500" in fr-CA as ambiguous', () => {
    // Comma + exactly 3 trailing digits in a comma-decimal locale: could be
    // 1.500 (one and a half) or 1 500 (fifteen hundred). 1000x apart.
    const r = parseAmountToCents('1,500', 'fr-CA');
    expect(r.ambiguous).toBe(true);
  });

  it('does NOT flag an unambiguous fr-CA decimal', () => {
    // 2 trailing digits reads as cents in any reasonable interpretation.
    expect(parseAmountToCents('45,50', 'fr-CA').ambiguous).toBe(false);
  });

  it('does NOT flag en-US "1,500" — comma-thousands is unambiguous there', () => {
    expect(parseAmountToCents('1,500', 'en-US').ambiguous).toBe(false);
  });

  it('always reports the interpretation it chose, so callers can echo it', () => {
    const r = parseAmountToCents('1,500', 'fr-CA');
    expect(r.cents).toBeTypeOf('number');
    // The caller shows this back to the user before booking anything.
    expect(r.formatted).toBeTypeOf('string');
    expect(r.formatted.length).toBeGreaterThan(0);
  });
});

describe('parseAmountToCents — rejection', () => {
  it('returns ok:false for non-numeric input rather than NaN cents', () => {
    for (const bad of ['', '   ', 'abc', '$', '-', '.', ',', 'NaN', 'Infinity']) {
      const r = parseAmountToCents(bad, 'en-US');
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('never returns NaN or Infinity in cents', () => {
    for (const bad of ['abc', '', 'Infinity', '1e999']) {
      const r = parseAmountToCents(bad, 'en-US');
      if (r.ok) expect(Number.isFinite(r.cents)).toBe(true);
    }
  });

  it('rejects rather than silently truncating an absurd magnitude', () => {
    const r = parseAmountToCents('1e999', 'en-US');
    expect(r.ok).toBe(false);
  });
});

describe('round-trip property: parse(format(x)) === x', () => {
  it('holds for every locale and a spread of amounts', async () => {
    const { formatCurrency } = await import('../formatters.js');
    const cases: Array<[string, string]> = [
      ['en-US', 'USD'],
      ['fr-CA', 'CAD'],
      ['zh-CN', 'CNY'],
    ];
    const amounts = [0, 1, 99, 100, 4550, 150075, 123456789, -4550];

    for (const [locale, currency] of cases) {
      for (const cents of amounts) {
        const rendered = formatCurrency(cents, locale, currency);
        const back = parseAmountToCents(rendered, locale);
        expect(back.ok, `${locale} ${cents} -> "${rendered}"`).toBe(true);
        expect(back.cents, `${locale} ${cents} -> "${rendered}" -> ${back.cents}`).toBe(cents);
      }
    }
  });
});

describe('parseDateInput', () => {
  it('parses ISO dates in every locale', () => {
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      const r = parseDateInput('2026-03-22', loc);
      expect(r.ok, loc).toBe(true);
      expect(r.iso, loc).toBe('2026-03-22');
    }
  });

  it('reads slash dates as month-first in en-US', () => {
    const r = parseDateInput('03/04/2026', 'en-US');
    expect(r.iso).toBe('2026-03-04');
  });

  it('reads slash dates month-first in fr-CA, because fr-CA is ISO-order', () => {
    // CORRECTION to an earlier assumption: fr-CA is NOT day-first. Intl
    // formats it '2026-03-21' (year, month, day) — it is *fr-FR* that writes
    // '21/03/2026'. So a bare slash date in fr-CA falls back to month-first,
    // the same as en-US, and Canadian French carries LESS date ambiguity than
    // metropolitan French would.
    const r = parseDateInput('03/04/2026', 'fr-CA');
    expect(r.iso).toBe('2026-03-04');
  });

  it('reads slash dates as day-first in a genuinely day-first locale (fr-FR)', () => {
    // Same string, different date — the reason ambiguous input must be echoed
    // back rather than silently committed.
    expect(parseDateInput('03/04/2026', 'fr-FR').iso).toBe('2026-04-03');
  });

  it('flags a day/month-ambiguous slash date as ambiguous', () => {
    expect(parseDateInput('03/04/2026', 'en-US').ambiguous).toBe(true);
    // Unambiguous: 22 cannot be a month, so only one reading is a real date.
    expect(parseDateInput('22/03/2026', 'fr-CA').ambiguous).toBe(false);
    expect(parseDateInput('22/03/2026', 'fr-CA').iso).toBe('2026-03-22');
    // ISO is never ambiguous.
    expect(parseDateInput('2026-03-22', 'en-US').ambiguous).toBe(false);
  });

  it('rejects nonsense without throwing', () => {
    for (const bad of ['', 'not a date', '99/99/9999', '2026-13-45']) {
      expect(parseDateInput(bad, 'en-US').ok, bad).toBe(false);
    }
  });

  it('does not shift the day across timezones', () => {
    // The pre-existing formatDate bug in reverse: a date-only value must not
    // move because the host is west of UTC.
    const r = parseDateInput('2026-03-22', 'en-US');
    expect(r.iso).toBe('2026-03-22');
  });
});

describe('parseAmountToCents — replaces the NaN-to-API path', () => {
  // What the form sites actually suffered from. These are <input type="number">
  // fields, whose value-sanitization algorithm blanks any non-canonical value
  // (verified in jsdom: setting '45,50' gives value === ''). So the old code
  // did NOT misread French input by 100x — it produced NaN:
  //
  //     Math.round(parseFloat('') * 100)  ->  NaN
  //
  // and NaN went into the request body as amountCents.
  it('returns ok:false and 0 for the blank a number input produces', () => {
    const r = parseAmountToCents('', 'fr-CA');
    expect(r.ok).toBe(false);
    expect(r.cents).toBe(0);
    expect(Number.isNaN(r.cents)).toBe(false);
  });

  it('never yields NaN cents for any input a number field can emit', () => {
    for (const raw of ['', '   ', '45.50', '8.875', '0', '-0']) {
      const r = parseAmountToCents(raw, 'en-US');
      expect(Number.isNaN(r.cents), JSON.stringify(raw)).toBe(false);
      expect(Number.isFinite(r.cents), JSON.stringify(raw)).toBe(true);
    }
  });

  it('is cents-quantised, so it must NOT be used for rate fields', () => {
    // Documents a real constraint rather than a behaviour to rely on.
    // A tax-rate input uses step=0.001 (e.g. 8.875%). Round-tripping that
    // through cents loses the third decimal, silently changing the tax on an
    // invoice — so rate/quantity fields keep plain numeric parsing.
    const r = parseAmountToCents('8.875', 'en-US');
    expect(r.cents).toBe(888); // 8.88, NOT 8.875
    expect(r.cents / 100).not.toBe(8.875);
  });
});
