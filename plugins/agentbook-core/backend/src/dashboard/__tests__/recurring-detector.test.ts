import { describe, it, expect } from 'vitest';
import { detectRecurringFromHistory, type ExpenseRow } from '../recurring-detector.js';

const exp = (id: string, vendor: string, amountCents: number, date: string): ExpenseRow => ({
  id, vendor, amountCents, date: new Date(date),
});

describe('detectRecurringFromHistory', () => {
  it('detects monthly recurring with 3+ occurrences at 25–35d cadence', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'AWS', 34000, '2026-02-01'),
      exp('2', 'AWS', 34500, '2026-03-02'),
      exp('3', 'AWS', 33700, '2026-04-01'),
    ];
    const today = new Date('2026-05-01');
    const result = detectRecurringFromHistory(rows, today);
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe('AWS');
    expect(Math.round(result[0].amountCents / 100)).toBeCloseTo(341, 0);
    expect(result[0].nextExpectedDate.startsWith('2026-05')).toBe(true);
  });

  it('does NOT detect when only 2 occurrences', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'AWS', 34000, '2026-03-01'),
      exp('2', 'AWS', 34500, '2026-04-01'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('rejects clusters whose amounts vary > ±10%', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Variable', 10000, '2026-02-01'),
      exp('2', 'Variable', 30000, '2026-03-01'),
      exp('3', 'Variable', 50000, '2026-04-01'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('rejects clusters whose cadence is outside 25–35 days', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Weekly', 10000, '2026-04-01'),
      exp('2', 'Weekly', 10000, '2026-04-08'),
      exp('3', 'Weekly', 10000, '2026-04-15'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('groups by normalized vendor (case + whitespace insensitive)', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Netflix', 1599, '2026-02-15'),
      exp('2', 'NETFLIX ', 1599, '2026-03-15'),
      exp('3', 'netflix', 1599, '2026-04-15'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(1);
  });
});
