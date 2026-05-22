import { describe, it, expect } from 'vitest';
import { parseCSVRow } from '../server';

describe('parseCSVRow — RFC-4180-aware (G-035)', () => {
  it('parses a simple unquoted row', () => {
    expect(parseCSVRow('2026-03-01,100.00,Coffee')).toEqual(['2026-03-01', '100.00', 'Coffee']);
  });

  it('handles a quoted field with internal comma', () => {
    expect(parseCSVRow('2026-03-01,42.50,"Subway #1234, NYC"')).toEqual([
      '2026-03-01',
      '42.50',
      'Subway #1234, NYC',
    ]);
  });

  it('handles multiple quoted fields', () => {
    expect(parseCSVRow('"Acme, Inc.",100.00,"Lunch, with client"')).toEqual([
      'Acme, Inc.',
      '100.00',
      'Lunch, with client',
    ]);
  });

  it('handles escaped quotes (RFC 4180 "")', () => {
    expect(parseCSVRow('1,"He said ""hi""",2')).toEqual(['1', 'He said "hi"', '2']);
  });

  it('trims whitespace around fields', () => {
    expect(parseCSVRow(' 2026-03-01 , 100.00 , Coffee ')).toEqual([
      '2026-03-01',
      '100.00',
      'Coffee',
    ]);
  });

  it('handles trailing empty field', () => {
    expect(parseCSVRow('a,b,')).toEqual(['a', 'b', '']);
  });

  it('handles leading empty field', () => {
    expect(parseCSVRow(',a,b')).toEqual(['', 'a', 'b']);
  });

  it('handles empty row', () => {
    expect(parseCSVRow('')).toEqual(['']);
  });

  it('handles real-world bank CSV row', () => {
    // Chase-style: "Date","Description","Amount","Type","Balance"
    expect(
      parseCSVRow('"03/01/2026","UBER   *TRIP HELP.UBER.COM CA","-12.50","Sale","1234.56"'),
    ).toEqual(['03/01/2026', 'UBER   *TRIP HELP.UBER.COM CA', '-12.50', 'Sale', '1234.56']);
  });
});
