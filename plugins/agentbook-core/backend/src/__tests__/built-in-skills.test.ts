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

describe('BUILT_IN_SKILLS — no manifest points at the dead /ask route', () => {
  /**
   * `POST /api/v1/agentbook-core/ask` is mounted only by `tsx src/server.ts`.
   * Production serves the Next route handlers, which never carried a port of
   * it, so any skill whose manifest names it fails with NOT_IMPLEMENTED for
   * every real user. `general-question` was moved off it; `query-finance` was
   * still on it, and its non-cash cases were answered by the failure branch's
   * clarifying question instead of by anything that had read the ledger.
   */
  it('query-finance is INTERNAL — the cash shortcut inline, the rest via the brain', () => {
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'query-finance');
    expect(skill).toBeDefined();
    expect(skill?.endpoint).toEqual({ method: 'INTERNAL', url: '' });
  });

  it('nothing else regresses onto it', () => {
    const onDeadRoute = BUILT_IN_SKILLS
      .filter((s) => (s.endpoint as any)?.url === '/api/v1/agentbook-core/ask')
      .map((s) => s.name);
    expect(onDeadRoute, 'these skills route to an endpoint prod does not mount').toEqual([]);
  });
});
