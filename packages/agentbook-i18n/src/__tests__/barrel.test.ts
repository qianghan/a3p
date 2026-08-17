import { describe, it, expect } from 'vitest';
import { parseAmountToCents, parseDateInput, formatDate, formatMoney } from '../index.js';

describe('public barrel exports', () => {
  it('exposes parsing alongside formatting, so callers cannot get one without the other', () => {
    expect(typeof parseAmountToCents).toBe('function');
    expect(typeof parseDateInput).toBe('function');
    expect(typeof formatDate).toBe('function');
    expect(typeof formatMoney).toBe('function');
  });

  it('round-trips fr-CA money through the public surface', () => {
    const rendered = formatMoney(4550, 'CAD');
    expect(parseAmountToCents(rendered, 'fr-CA').cents).toBe(4550);
    // The bug this pairing prevents.
    expect(parseAmountToCents('45,50', 'fr-CA').cents).toBe(4550);
  });

  it('date-only formatting does not shift the day via the public surface', () => {
    expect(formatDate('2026-03-22', 'en-US')).toMatch(/22/);
  });
});
