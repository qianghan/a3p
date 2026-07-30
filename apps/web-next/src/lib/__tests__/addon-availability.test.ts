import { describe, it, expect } from 'vitest';
import { isAddOnAvailable, ADDON_JURISDICTIONS } from '../addon-availability';

describe('isAddOnAvailable', () => {
  it('startup_tax_benefits is available only where the engine exists (US + AU)', () => {
    expect(isAddOnAvailable('startup_tax_benefits', 'us')).toBe(true);
    expect(isAddOnAvailable('startup_tax_benefits', 'au')).toBe(true);
    expect(isAddOnAvailable('startup_tax_benefits', 'ca')).toBe(false); // sold-but-broken before this fix
    expect(isAddOnAvailable('startup_tax_benefits', 'uk')).toBe(false);
  });

  it('is case-insensitive and defaults region to us', () => {
    expect(isAddOnAvailable('startup_tax_benefits', 'US')).toBe(true);
    expect(isAddOnAvailable('startup_tax_benefits', null)).toBe(true); // us
    expect(isAddOnAvailable('startup_tax_benefits', undefined)).toBe(true);
  });

  it('un-listed add-ons are available in every region', () => {
    for (const r of ['us', 'ca', 'uk', 'au']) {
      expect(isAddOnAvailable('student_success', r)).toBe(true);
      expect(isAddOnAvailable('tax_fast_track', r)).toBe(true);
    }
    expect('student_success' in ADDON_JURISDICTIONS).toBe(false);
  });
});
