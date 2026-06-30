import { describe, it, expect } from 'vitest';
import { parseToggle, toSkillDTO } from '../admin-skills';

describe('admin-skills · parseToggle', () => {
  it('accepts a valid {name, enabled}', () => {
    expect(parseToggle({ name: 'record-expense', enabled: false })).toEqual({
      name: 'record-expense',
      enabled: false,
    });
  });

  it('rejects a missing or empty name', () => {
    expect(parseToggle({ enabled: true })).toBeNull();
    expect(parseToggle({ name: '', enabled: true })).toBeNull();
    expect(parseToggle({ name: '   ', enabled: true })).toBeNull();
  });

  it('rejects a non-boolean enabled', () => {
    expect(parseToggle({ name: 'x', enabled: 'yes' })).toBeNull();
    expect(parseToggle({ name: 'x' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseToggle(null)).toBeNull();
    expect(parseToggle('nope')).toBeNull();
  });

  it('trims the name', () => {
    expect(parseToggle({ name: '  scan-receipt  ', enabled: true })).toEqual({
      name: 'scan-receipt',
      enabled: true,
    });
  });
});

describe('admin-skills · toSkillDTO', () => {
  it('projects only the admin-facing fields', () => {
    const dto = toSkillDTO({
      name: 'record-expense',
      description: 'Record an expense',
      category: 'expense',
      source: 'built_in',
      enabled: true,
      triggerPatterns: ['secret'],
      endpoint: { url: 'x' },
    });
    expect(dto).toEqual({
      name: 'record-expense',
      description: 'Record an expense',
      category: 'expense',
      source: 'built_in',
      enabled: true,
    });
  });
});
