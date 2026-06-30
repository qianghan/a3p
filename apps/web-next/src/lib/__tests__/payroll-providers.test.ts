import { describe, it, expect } from 'vitest';
import {
  resolveProviderId,
  parseProviderUpdate,
  isProviderLive,
  PAYROLL_PROVIDERS,
} from '../payroll/providers';

describe('payroll providers · registry', () => {
  it('calculator is the only live provider', () => {
    expect(isProviderLive('calculator')).toBe(true);
    expect(isProviderLive('deel')).toBe(false);
    expect(isProviderLive('finch')).toBe(false);
    expect(isProviderLive('check')).toBe(false);
  });
  it('exposes the four providers', () => {
    expect(PAYROLL_PROVIDERS.map((p) => p.id)).toEqual(['calculator', 'finch', 'check', 'deel']);
  });
});

describe('payroll providers · resolveProviderId', () => {
  it('defaults to calculator when no config', () => {
    expect(resolveProviderId([], 'us')).toBe('calculator');
  });
  it('returns the configured provider for an enabled row', () => {
    const rows = [{ jurisdiction: 'us', provider: 'check', enabled: true }];
    expect(resolveProviderId(rows, 'us')).toBe('check');
  });
  it('ignores disabled rows and unknown providers', () => {
    expect(resolveProviderId([{ jurisdiction: 'ca', provider: 'deel', enabled: false }], 'ca')).toBe('calculator');
    expect(resolveProviderId([{ jurisdiction: 'us', provider: 'bogus', enabled: true }], 'us')).toBe('calculator');
  });
});

describe('payroll providers · parseProviderUpdate', () => {
  it('accepts a valid update', () => {
    expect(parseProviderUpdate({ jurisdiction: 'CA', provider: 'deel', apiKey: 'k' })).toEqual({
      jurisdiction: 'ca',
      provider: 'deel',
      apiKey: 'k',
    });
  });
  it('omits a blank apiKey', () => {
    expect(parseProviderUpdate({ jurisdiction: 'us', provider: 'calculator', apiKey: '  ' })).toEqual({
      jurisdiction: 'us',
      provider: 'calculator',
    });
  });
  it('rejects unknown jurisdiction / provider / shape', () => {
    expect(parseProviderUpdate({ jurisdiction: 'fr', provider: 'deel' })).toBeNull();
    expect(parseProviderUpdate({ jurisdiction: 'us', provider: 'adp' })).toBeNull();
    expect(parseProviderUpdate(null)).toBeNull();
  });
});
