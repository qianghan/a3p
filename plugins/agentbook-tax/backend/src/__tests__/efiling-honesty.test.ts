import { describe, it, expect } from 'vitest';
import { buildFilingOutcome } from '../tax-efiling.js';

const result = { confirmationNumber: 'AB-XYZ', status: 'accepted' };

describe('buildFilingOutcome — never falsely reports "filed"', () => {
  it('mock / no-partner path is EXPORTED, not filed', () => {
    const o = buildFilingOutcome(false, result);
    expect(o.dbStatus).toBe('exported');
    expect(o.filed).toBe(false);
    expect(o.filedAtDate).toBeNull();
    expect(o.filedStatus).toBe('exported_not_filed');
    expect(o.message).toMatch(/NOT a filing/i);
    expect(o.message).not.toMatch(/filed with the tax authority/i);
  });

  it('certified-partner acceptance IS a real filing', () => {
    const o = buildFilingOutcome(true, result);
    expect(o.dbStatus).toBe('filed');
    expect(o.filed).toBe(true);
    expect(o.filedAtDate).toBeInstanceOf(Date);
    expect(o.message).toMatch(/filed with the tax authority/i);
  });
});
