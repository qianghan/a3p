import { describe, it, expect } from 'vitest';
import { taxYearBounds, taxYearFromText, currentTaxYear, taxYearZone } from '../restatement-year';

/** PR 2c review I-1 / M-3: one tax-year definition for route, card and chat. */
describe('restatement tax year', () => {
  it('AU ranges and FY labels name the year they END in', () => {
    for (const t of ['restate my 2025-2026 purchases', 'restate 2025–2026', 'FY2025-26 please', 'restate 2025/26', 'FY2026', 'restate FY26', 'restate 2026']) {
      expect(taxYearFromText(t, 'au'), t).toBe(2026);
    }
    expect(taxYearFromText('restate my GST', 'au')).toBeNull();
  });
  it('CA is the calendar year named', () => {
    expect(taxYearFromText('restate my GST for 2025', 'ca')).toBe(2025);
  });
  it('bounds', () => {
    expect([taxYearBounds('au', 2026).fromIso, taxYearBounds('au', 2026).toIso]).toEqual(['2025-07-01', '2026-06-30']);
    expect([taxYearBounds('ca', 2026).fromIso, taxYearBounds('ca', 2026).toIso]).toEqual(['2026-01-01', '2026-12-31']);
  });
  it('today is read in the tenant zone: 1 Jul in Sydney is the new AU year while UTC is still 30 Jun', () => {
    const utc30Jun = new Date('2026-06-30T15:00:00Z'); // 01:00 1 Jul AEST
    expect(currentTaxYear('au', utc30Jun, 'Australia/Sydney')).toBe(2027);
    // the platform default zone is not an AU tenant's real zone
    expect(taxYearZone('au', 'America/New_York')).toBe('Australia/Sydney');
    expect(currentTaxYear('au', utc30Jun, 'America/New_York')).toBe(2027);
    expect(currentTaxYear('ca', new Date('2027-01-01T03:00:00Z'), 'America/Toronto')).toBe(2026);
  });
});
