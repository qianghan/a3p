import { describe, it, expect } from 'vitest';
import { normalizeRegionCode } from '../region-codes';

describe('normalizeRegionCode (M2)', () => {
  it('accepts a valid US 2-letter code (case-insensitive)', () => {
    expect(normalizeRegionCode('us', 'ca')).toEqual({ ok: true, value: 'CA' });
    expect(normalizeRegionCode('us', 'NY')).toEqual({ ok: true, value: 'NY' });
  });

  it('maps a US full state name to its code', () => {
    expect(normalizeRegionCode('us', 'California')).toEqual({ ok: true, value: 'CA' });
    expect(normalizeRegionCode('us', 'new york')).toEqual({ ok: true, value: 'NY' });
    expect(normalizeRegionCode('us', 'District of Columbia')).toEqual({ ok: true, value: 'DC' });
  });

  it('rejects an unrecognized US region (the mis-tax case) with a helpful error', () => {
    const r = normalizeRegionCode('us', 'Californiaa');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2-letter code/);
  });

  it('maps CA province names (incl. accented Québec) to codes', () => {
    expect(normalizeRegionCode('ca', 'Ontario')).toEqual({ ok: true, value: 'ON' });
    expect(normalizeRegionCode('ca', 'Québec')).toEqual({ ok: true, value: 'QC' });
    expect(normalizeRegionCode('ca', 'bc')).toEqual({ ok: true, value: 'BC' });
  });

  it('rejects an unrecognized CA province', () => {
    expect(normalizeRegionCode('ca', 'Onterio').ok).toBe(false);
  });

  it('treats empty region as allowed (optional)', () => {
    expect(normalizeRegionCode('us', '')).toEqual({ ok: true, value: '' });
    expect(normalizeRegionCode('ca', '   ')).toEqual({ ok: true, value: '' });
  });

  it('passes AU/UK regions through uppercased without rejecting (no strict code table)', () => {
    expect(normalizeRegionCode('au', 'nsw')).toEqual({ ok: true, value: 'NSW' });
    expect(normalizeRegionCode('uk', 'england')).toEqual({ ok: true, value: 'ENGLAND' });
  });

  it('defaults an absent jurisdiction to US validation', () => {
    expect(normalizeRegionCode(undefined, 'Texas')).toEqual({ ok: true, value: 'TX' });
  });
});
