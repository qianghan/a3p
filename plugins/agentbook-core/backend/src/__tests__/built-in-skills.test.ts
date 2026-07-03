import { describe, it, expect } from 'vitest';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';

describe('BUILT_IN_SKILLS — us-rd-credit-finder', () => {
  it('is registered with an HTTP endpoint pointing at the startup plugin', () => {
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'us-rd-credit-finder');
    expect(skill).toBeDefined();
    expect(skill?.endpoint).toEqual({ method: 'GET', url: '/api/v1/agentbook-startup/recommendations' });
  });

  it('triggers on common R&D-credit and startup-tax-benefit phrasing', () => {
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'us-rd-credit-finder')!;
    const patterns = skill.triggerPatterns.map((p) => new RegExp(p, 'i'));
    for (const phrase of ['do we qualify for the r&d credit', 'startup tax benefits', 'qsbs eligibility', 'delaware franchise tax']) {
      expect(patterns.some((re) => re.test(phrase))).toBe(true);
    }
  });

  it('is registered before the general-question fallback', () => {
    const names = BUILT_IN_SKILLS.map((s) => s.name);
    expect(names.indexOf('us-rd-credit-finder')).toBeLessThan(names.indexOf('general-question'));
  });
});
