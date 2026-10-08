import { describe, it, expect } from 'vitest';
import { getQuarterlyDeadlines } from '../agentbook-quarterly-deadlines';

const ymd = (year: number, j: string) =>
  getQuarterlyDeadlines(year, j).map((d) => [d.quarter, d.deadline.toISOString().slice(0, 10)]);

describe('getQuarterlyDeadlines (moved verbatim from tax/quarterly/route.ts)', () => {
  it('US IRS schedule (Q4 in January of the next year)', () => {
    expect(ymd(2026, 'us')).toEqual([[1, '2026-04-15'], [2, '2026-06-15'], [3, '2026-09-15'], [4, '2027-01-15']]);
  });
  it('CA CRA instalments', () => {
    expect(ymd(2026, 'ca')).toEqual([[1, '2026-03-15'], [2, '2026-06-15'], [3, '2026-09-15'], [4, '2026-12-15']]);
  });
  it('AU PAYG instalments across the July–June financial year', () => {
    expect(ymd(2026, 'au')).toEqual([[1, '2026-10-28'], [2, '2027-02-28'], [3, '2027-04-28'], [4, '2027-07-28']]);
  });
  it('any other jurisdiction falls back to the US schedule (unchanged behaviour)', () => {
    expect(ymd(2026, 'uk')).toEqual(ymd(2026, 'us'));
  });
});
