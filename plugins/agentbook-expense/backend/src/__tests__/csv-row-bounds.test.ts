import { describe, it, expect } from 'vitest';
import { parseCSVRow } from '../server.js';

/**
 * Bounds on one CSV row.
 *
 * The parse is linear and advances monotonically, so a long line costs time
 * proportional to its own length and nothing worse — CodeQL's
 * `js/loop-bound-injection` overstates it. But "proportional to the input"
 * stops being reassuring when the input is an uploaded file: a single 4 MB
 * line is a 4 MB string assembled one character at a time, and no bank export
 * has ever produced one.
 *
 * Truncation, not rejection: a malformed row must not fail an import of two
 * thousand good ones.
 */

describe('real CSV rows are untouched', () => {
  it('parses a normal bank statement row', () => {
    expect(parseCSVRow('2026-03-01,"COFFEE SHOP, LTD",-4.50,AUD'))
      .toEqual(['2026-03-01', 'COFFEE SHOP, LTD', '-4.50', 'AUD']);
  });

  it('still handles escaped quotes inside a quoted field', () => {
    // The behaviour G-035 was fixed to get right; the bound must not break it.
    expect(parseCSVRow('a,"He said ""hi""",b')).toEqual(['a', 'He said "hi"', 'b']);
  });

  it('handles a wide-but-plausible row', () => {
    const wide = Array.from({ length: 60 }, (_, i) => `col${i}`).join(',');
    expect(parseCSVRow(wide)).toHaveLength(60);
  });
});

describe('absurd rows are bounded', () => {
  it('caps the characters it will walk', () => {
    const huge = 'x'.repeat(200_000);
    const out = parseCSVRow(huge);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThanOrEqual(64 * 1024);
  });

  it('caps the number of fields', () => {
    const many = 'a,'.repeat(5_000);
    expect(parseCSVRow(many).length).toBeLessThanOrEqual(512);
  });

  it('returns promptly on a pathological line', () => {
    // An unterminated quote followed by a megabyte of commas: the shape most
    // likely to make a hand-rolled parser do something quadratic.
    const started = Date.now();
    parseCSVRow('"' + ','.repeat(1_000_000));
    expect(Date.now() - started).toBeLessThan(250);
  });
});
