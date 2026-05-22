import { describe, it, expect } from 'vitest';
import { selectSkillByPatterns } from '../skill-routing.js';

describe('selectSkillByPatterns', () => {
  it('rejects skill with no triggerPatterns', () => {
    const skill = { name: 'foo', triggerPatterns: [] };
    expect(selectSkillByPatterns(skill, 'anything', 'anything')).toBe(false);
  });

  it('rejects skill with undefined triggerPatterns', () => {
    const skill = { name: 'foo' };
    expect(selectSkillByPatterns(skill, 'anything', 'anything')).toBe(false);
  });

  it('accepts skill when triggerPattern matches', () => {
    const skill = { name: 'record-expense', triggerPatterns: ['spent'] };
    expect(selectSkillByPatterns(skill, 'spent $5 on coffee', 'spent $5 on coffee')).toBe(true);
  });

  it('rejects when triggerPatterns match but requirePatterns dont', () => {
    const skill = {
      name: 'record-expense',
      triggerPatterns: ['spent'],
      requirePatterns: ['\\$\\s*[\\d,]+'],
    };
    expect(selectSkillByPatterns(skill, 'spent some money', 'spent some money')).toBe(false);
    expect(selectSkillByPatterns(skill, 'spent $5', 'spent $5')).toBe(true);
  });

  it('rejects when excludePattern matches', () => {
    const skill = {
      name: 'record-expense',
      triggerPatterns: ['spent'],
      excludePatterns: ['what\\s*if'],
    };
    expect(selectSkillByPatterns(skill, 'what if I spent $5', 'what if i spent $5')).toBe(false);
    expect(selectSkillByPatterns(skill, 'spent $5', 'spent $5')).toBe(true);
  });

  it('invalid regex in patterns does not throw', () => {
    const skill = { name: 'foo', triggerPatterns: ['valid', '[invalid('] };
    // Should not throw; should fall through to next pattern
    expect(selectSkillByPatterns(skill, 'valid', 'valid')).toBe(true);
  });

  it('invalid regex in excludePatterns does not throw', () => {
    const skill = {
      name: 'foo',
      triggerPatterns: ['spent'],
      excludePatterns: ['[invalid('],
    };
    expect(selectSkillByPatterns(skill, 'spent $5', 'spent $5')).toBe(true);
  });

  it('record-expense canonical: rejects "what if I spent $5"', () => {
    const skill = {
      name: 'record-expense',
      triggerPatterns: ['spent', 'paid', 'bought'],
      requirePatterns: ['\\$\\s*[\\d,]+'],
      excludePatterns: ['what\\s*if', '^invoice'],
    };
    expect(selectSkillByPatterns(skill, 'what if I spent $500', 'what if i spent $500')).toBe(false);
    expect(selectSkillByPatterns(skill, 'spent $500 on lunch', 'spent $500 on lunch')).toBe(true);
  });

  it('query-finance canonical: rejects tax-specific queries', () => {
    const skill = {
      name: 'query-finance',
      triggerPatterns: ['how much'],
      excludePatterns: ['tax.*estimate', 'how much.*tax'],
    };
    expect(selectSkillByPatterns(skill, 'how much do I owe in tax', 'how much do i owe in tax')).toBe(false);
    expect(selectSkillByPatterns(skill, 'how much have I spent this month', 'how much have i spent this month')).toBe(true);
  });

  it('all requirePatterns must match (AND semantics)', () => {
    const skill = {
      name: 'foo',
      triggerPatterns: ['anything'],
      requirePatterns: ['hello', 'world'],
    };
    expect(selectSkillByPatterns(skill, 'anything hello', 'anything hello')).toBe(false);
    expect(selectSkillByPatterns(skill, 'anything world', 'anything world')).toBe(false);
    expect(selectSkillByPatterns(skill, 'anything hello world', 'anything hello world')).toBe(true);
  });

  it('any excludePattern triggers rejection (OR semantics across excludes)', () => {
    const skill = {
      name: 'foo',
      triggerPatterns: ['spent'],
      excludePatterns: ['cat', 'dog'],
    };
    expect(selectSkillByPatterns(skill, 'spent on cat', 'spent on cat')).toBe(false);
    expect(selectSkillByPatterns(skill, 'spent on dog', 'spent on dog')).toBe(false);
    expect(selectSkillByPatterns(skill, 'spent on bird', 'spent on bird')).toBe(true);
  });
});
