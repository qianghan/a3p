import { describe, it, expect } from 'vitest';
import { buildStpPayEvent, auFinancialYearOf, auFinancialYearStart } from '../au/stp-pay-event.js';

describe('buildStpPayEvent (AU STP Phase 2, Wave 2)', () => {
  const base = { financialYear: 2026, periodStart: '2026-03-01', periodEnd: '2026-03-14' };

  it('rolls per-payee YTD into employer totals and stays "prepared" (not lodged)', () => {
    const ev = buildStpPayEvent({
      ...base,
      payees: [
        { employeeId: 'e1', name: 'Ann', ytdGrossCents: 6_000_000, ytdPaygWithheldCents: 1_200_000, ytdSuperCents: 720_000 },
        { employeeId: 'e2', name: 'Bo', ytdGrossCents: 4_000_000, ytdPaygWithheldCents: 700_000, ytdSuperCents: 480_000 },
      ],
    });
    expect(ev.employerTotals).toEqual({
      ytdGrossCents: 10_000_000,
      ytdPaygWithheldCents: 1_900_000,
      ytdSuperCents: 1_200_000,
      payeeCount: 2,
    });
    expect(ev.lodgment).toBe('prepared'); // never auto-lodged without ATO accreditation
    expect(ev.financialYear).toBe(2026);
  });

  it('handles a nil pay event (no payees)', () => {
    const ev = buildStpPayEvent({ ...base, payees: [] });
    expect(ev.employerTotals.payeeCount).toBe(0);
    expect(ev.employerTotals.ytdGrossCents).toBe(0);
  });
});

describe('AU financial-year helpers', () => {
  it('maps a date to the FY ending in the correct calendar year (FY = 1 Jul–30 Jun)', () => {
    expect(auFinancialYearOf(new Date('2026-03-15T00:00:00Z'))).toBe(2026); // Mar 2026 → FY2025-26
    expect(auFinancialYearOf(new Date('2025-08-01T00:00:00Z'))).toBe(2026); // Aug 2025 → FY2025-26
    expect(auFinancialYearOf(new Date('2025-06-30T00:00:00Z'))).toBe(2025); // Jun 2025 → FY2024-25
  });
  it('gives the 1 Jul start of the FY', () => {
    expect(auFinancialYearStart(2026).toISOString().slice(0, 10)).toBe('2025-07-01');
  });
});
