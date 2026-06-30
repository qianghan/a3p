import { describe, it, expect } from 'vitest';
import { normalizeFlagKey, parseFlagUpsert } from '../admin-feature-flags';

describe('admin-feature-flags · normalizeFlagKey', () => {
  it('lowercases and trims', () => {
    expect(normalizeFlagKey('  New_Feature  ')).toBe('new_feature');
  });
  it('rejects empty / invalid characters', () => {
    expect(normalizeFlagKey('')).toBeNull();
    expect(normalizeFlagKey('has space')).toBeNull();
    expect(normalizeFlagKey('bad/slash')).toBeNull();
  });
  it('allows dot, dash, underscore, digits', () => {
    expect(normalizeFlagKey('agentbook.payroll-v2_beta')).toBe('agentbook.payroll-v2_beta');
  });
});

describe('admin-feature-flags · parseFlagUpsert', () => {
  it('accepts key + enabled (+ optional description)', () => {
    expect(parseFlagUpsert({ key: 'New.Flag', enabled: true, description: ' beta ' })).toEqual({
      key: 'new.flag',
      enabled: true,
      description: 'beta',
    });
  });
  it('defaults description to undefined', () => {
    expect(parseFlagUpsert({ key: 'x', enabled: false })).toEqual({ key: 'x', enabled: false, description: undefined });
  });
  it('rejects bad key / non-boolean enabled / non-object', () => {
    expect(parseFlagUpsert({ key: 'bad key', enabled: true })).toBeNull();
    expect(parseFlagUpsert({ key: 'x', enabled: 'yes' })).toBeNull();
    expect(parseFlagUpsert({ enabled: true })).toBeNull();
    expect(parseFlagUpsert(null)).toBeNull();
  });
});
