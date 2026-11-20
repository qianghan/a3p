/**
 * PR 4c — pay-frequency labels and draft pay-period math (spec §5.5).
 *
 * Every expected date below is computed by hand from the calendar, not read
 * back from the implementation: the point is to catch an off-by-one at month
 * ends, leap days and anchors on either side of the run date.
 */
import { describe, it, expect } from 'vitest';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';
import {
  payPeriodFor, groupKey, frequencyLabelKey, PAY_FREQUENCIES, addDaysIso, toIsoDate,
} from '../payroll-frequency';

describe('frequencyLabelKey — market display map', () => {
  it('AU biweekly is Fortnightly; US/CA biweekly is Bi-weekly, in all three locales', () => {
    const en = createTranslator('en', CATALOG).t;
    const fr = createTranslator('fr-CA', CATALOG).t;
    const zh = createTranslator('zh-CN', CATALOG).t;
    expect(en(frequencyLabelKey('biweekly', 'au'))).toBe('Fortnightly');
    expect(en(frequencyLabelKey('biweekly', 'us'))).toBe('Bi-weekly');
    expect(en(frequencyLabelKey('biweekly', 'ca'))).toBe('Bi-weekly');
    expect(fr(frequencyLabelKey('biweekly', 'au'))).toBe('Aux deux semaines (quinzaine)');
    expect(fr(frequencyLabelKey('biweekly', 'ca'))).toBe('Aux deux semaines');
    expect(zh(frequencyLabelKey('biweekly', 'au'))).toBe('每两周（澳洲）');
    expect(zh(frequencyLabelKey('biweekly', 'us'))).toBe('每两周');
  });

  it('the chat reply catalog (agent namespace) carries the same map', () => {
    for (const loc of ['en', 'fr-CA', 'zh-CN']) {
      const t = createTranslator(loc, CATALOG).t;
      for (const f of PAY_FREQUENCIES) {
        for (const j of ['us', 'ca', 'au']) {
          expect(t(frequencyLabelKey(f, j, 'agent'))).toBe(t(frequencyLabelKey(f, j)));
        }
      }
    }
    expect(createTranslator('en', CATALOG).t(frequencyLabelKey('biweekly', 'au', 'agent'))).toBe('Fortnightly');
  });

  it('every frequency resolves to a real catalog string (not the humanised fallback)', () => {
    const en = createTranslator('en', CATALOG).t;
    expect(PAY_FREQUENCIES.map((f) => en(frequencyLabelKey(f, 'us')))).toEqual(['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly']);
  });
});

describe('date-only helpers', () => {
  it('adds days in UTC across a DST change without drifting', () => {
    // US DST starts 2026-03-08, AU DST ends 2026-04-05 — a local-time add would land on 23:00 the day before.
    expect(addDaysIso('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysIso('2026-03-07', 14)).toBe('2026-03-21');
    expect(addDaysIso('2026-04-04', 1)).toBe('2026-04-05');
    expect(addDaysIso('2026-11-01', -1)).toBe('2026-10-31');
  });
  it('toIsoDate takes the UTC calendar date of a stored DateTime', () => {
    expect(toIsoDate(new Date('2026-01-31T00:00:00.000Z'))).toBe('2026-01-31');
    expect(toIsoDate('2026-02-28T23:59:59.000Z')).toBe('2026-02-28');
  });
});

describe('payPeriodFor — weekly', () => {
  it('anchor in the past: the 7-day period containing asOf', () => {
    // anchor Mon 2026-01-05; 2026-03-11 is 65 days later → 9 full weeks (63d) → start 2026-03-09.
    expect(payPeriodFor('weekly', '2026-01-05', '2026-03-11')).toEqual({ periodStart: '2026-03-09', periodEnd: '2026-03-15', payDate: '2026-03-15' });
  });
  it('asOf on the anchor itself starts the first period', () => {
    expect(payPeriodFor('weekly', '2026-01-05', '2026-01-05')).toEqual({ periodStart: '2026-01-05', periodEnd: '2026-01-11', payDate: '2026-01-11' });
  });
  it('anchor in the future: the first period starts on the anchor', () => {
    expect(payPeriodFor('weekly', '2026-12-28', '2026-11-19')).toEqual({ periodStart: '2026-12-28', periodEnd: '2027-01-03', payDate: '2027-01-03' });
  });
});

describe('payPeriodFor — biweekly (fortnightly)', () => {
  it('14-day periods from the anchor, crossing a year end', () => {
    // anchor 2025-12-22; 2026-01-06 is 15 days later → 2nd period 2026-01-05..2026-01-18.
    expect(payPeriodFor('biweekly', '2025-12-22', '2026-01-06')).toEqual({ periodStart: '2026-01-05', periodEnd: '2026-01-18', payDate: '2026-01-18' });
    // last day of the first period
    expect(payPeriodFor('biweekly', '2025-12-22', '2026-01-04')).toEqual({ periodStart: '2025-12-22', periodEnd: '2026-01-04', payDate: '2026-01-04' });
  });
  it('spans a leap day (2028-02-29)', () => {
    // anchor 2028-02-21 → period 2028-02-21..2028-03-05 (Feb has 29 days in 2028).
    expect(payPeriodFor('biweekly', '2028-02-21', '2028-02-29')).toEqual({ periodStart: '2028-02-21', periodEnd: '2028-03-05', payDate: '2028-03-05' });
  });
  it('is DST-free: a period spanning the US spring-forward is exactly 14 calendar days', () => {
    expect(payPeriodFor('biweekly', '2026-03-02', '2026-03-09')).toEqual({ periodStart: '2026-03-02', periodEnd: '2026-03-15', payDate: '2026-03-15' });
  });
});

describe('payPeriodFor — semimonthly', () => {
  it('1st–15th', () => {
    expect(payPeriodFor('semimonthly', null, '2026-02-15')).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-02-15', payDate: '2026-02-15' });
  });
  it('16th–end of a 28-day February, a leap February, a 30- and a 31-day month', () => {
    expect(payPeriodFor('semimonthly', null, '2026-02-16')).toEqual({ periodStart: '2026-02-16', periodEnd: '2026-02-28', payDate: '2026-02-28' });
    expect(payPeriodFor('semimonthly', null, '2028-02-20')).toEqual({ periodStart: '2028-02-16', periodEnd: '2028-02-29', payDate: '2028-02-29' });
    expect(payPeriodFor('semimonthly', null, '2026-04-30')).toEqual({ periodStart: '2026-04-16', periodEnd: '2026-04-30', payDate: '2026-04-30' });
    expect(payPeriodFor('semimonthly', null, '2026-12-31')).toEqual({ periodStart: '2026-12-16', periodEnd: '2026-12-31', payDate: '2026-12-31' });
  });
  it('a future anchor moves the first period to the half-month containing the anchor', () => {
    expect(payPeriodFor('semimonthly', '2027-01-20', '2026-11-19')).toEqual({ periodStart: '2027-01-16', periodEnd: '2027-01-31', payDate: '2027-01-31' });
  });
});

describe('payPeriodFor — monthly', () => {
  it('calendar month, incl. leap and non-leap February', () => {
    expect(payPeriodFor('monthly', null, '2026-02-10')).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-02-28', payDate: '2026-02-28' });
    expect(payPeriodFor('monthly', null, '2024-02-29')).toEqual({ periodStart: '2024-02-01', periodEnd: '2024-02-29', payDate: '2024-02-29' });
    expect(payPeriodFor('monthly', '2026-01-31', '2026-11-19')).toEqual({ periodStart: '2026-11-01', periodEnd: '2026-11-30', payDate: '2026-11-30' });
  });
  it('a future anchor starts at the anchor’s month', () => {
    expect(payPeriodFor('monthly', '2027-03-15', '2026-11-19')).toEqual({ periodStart: '2027-03-01', periodEnd: '2027-03-31', payDate: '2027-03-31' });
  });
});

describe('payPeriodFor — guards', () => {
  it('weekly/biweekly without an anchor throws (the caller supplies a fallback)', () => {
    expect(() => payPeriodFor('weekly', null, '2026-01-01')).toThrow(/anchor/);
  });
  it('rejects an unknown frequency and a malformed date', () => {
    expect(() => payPeriodFor('daily' as never, '2026-01-01', '2026-01-01')).toThrow();
    expect(() => payPeriodFor('monthly', null, '2026-13-01')).toThrow();
  });
});

describe('groupKey', () => {
  it('weekly/biweekly employees group by frequency AND anchor; calendar frequencies by frequency only', () => {
    expect(groupKey('biweekly', '2026-01-05')).toBe('biweekly|2026-01-05');
    expect(groupKey('semimonthly', '2026-01-05')).toBe('semimonthly');
    expect(groupKey('monthly', null)).toBe('monthly');
  });
});
