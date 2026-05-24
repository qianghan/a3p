import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvWithHeaders } from '../agentbook-csv';

describe('parseCsv (G-035)', () => {
  it('parses a plain CSV', () => {
    const txt = 'date,amount,description\n2026-01-01,100,Lunch\n2026-01-02,42,Cab';
    expect(parseCsv(txt)).toEqual([
      ['date', 'amount', 'description'],
      ['2026-01-01', '100', 'Lunch'],
      ['2026-01-02', '42', 'Cab'],
    ]);
  });

  it('respects quoted commas (the real reason this PR exists)', () => {
    const txt = 'vendor,amount\n"Acme, Inc",100\n"Doe, Jr.",42';
    expect(parseCsv(txt)).toEqual([
      ['vendor', 'amount'],
      ['Acme, Inc', '100'],
      ['Doe, Jr.', '42'],
    ]);
  });

  it('handles escaped quotes ("")', () => {
    const txt = 'note\n"She said ""hi"""\n"plain"';
    expect(parseCsv(txt)).toEqual([['note'], ['She said "hi"'], ['plain']]);
  });

  it('handles CRLF line endings (Windows / Excel exports)', () => {
    const txt = 'a,b\r\n1,2\r\n3,4\r\n';
    expect(parseCsv(txt)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles newlines inside quoted fields', () => {
    const txt = 'memo,amount\n"line 1\nline 2",100';
    expect(parseCsv(txt)).toEqual([
      ['memo', 'amount'],
      ['line 1\nline 2', '100'],
    ]);
  });

  it('strips BOM', () => {
    const txt = '﻿date,amount\n2026-01-01,100';
    expect(parseCsv(txt)).toEqual([
      ['date', 'amount'],
      ['2026-01-01', '100'],
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('keeps empty fields (don’t collapse trailing commas)', () => {
    const txt = 'a,b,c\n1,,3';
    expect(parseCsv(txt)).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});

describe('parseCsvWithHeaders', () => {
  it('returns lowercase headers + row objects', () => {
    const txt = 'Date,Amount,Vendor\n2026-01-01,100,"Acme, Inc"';
    const { headers, rows } = parseCsvWithHeaders(txt);
    expect(headers).toEqual(['date', 'amount', 'vendor']);
    expect(rows).toEqual([{ date: '2026-01-01', amount: '100', vendor: 'Acme, Inc' }]);
  });

  it('trims field values', () => {
    const txt = 'a,b\n  1 , 2  ';
    const { rows } = parseCsvWithHeaders(txt);
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('handles missing trailing fields gracefully', () => {
    const txt = 'a,b,c\n1,2';
    const { rows } = parseCsvWithHeaders(txt);
    expect(rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});
