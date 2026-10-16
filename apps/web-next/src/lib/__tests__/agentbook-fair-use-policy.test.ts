import { describe, it, expect } from 'vitest';
import {
  warnLevelFor,
  ceilingForPlan,
  FAIR_USE_MONTHLY_AI_MESSAGES,
  FAIR_USE_DEFAULT_CEILING,
} from '../agentbook-fair-use-policy';

describe('warnLevelFor', () => {
  it('returns 0 below 70%', () => {
    expect(warnLevelFor(0, 100)).toBe(0);
    expect(warnLevelFor(69, 100)).toBe(0);
  });
  it('returns 0.7 at 70% up to below 90%', () => {
    expect(warnLevelFor(70, 100)).toBe(0.7);
    expect(warnLevelFor(89, 100)).toBe(0.7);
  });
  it('returns 0.9 at 90% and above', () => {
    expect(warnLevelFor(90, 100)).toBe(0.9);
    expect(warnLevelFor(150, 100)).toBe(0.9);
  });
  it('returns 0 for degenerate inputs', () => {
    expect(warnLevelFor(10, 0)).toBe(0);
    expect(warnLevelFor(-5, 100)).toBe(0);
  });
});

describe('ceilingForPlan', () => {
  it('returns the plan ceiling', () => {
    expect(ceilingForPlan('free')).toBe(FAIR_USE_MONTHLY_AI_MESSAGES.free);
    expect(ceilingForPlan('pro')).toBe(5000);
    expect(ceilingForPlan('business')).toBe(20000);
  });
  it('falls back to the default ceiling for unknown codes — never infinite', () => {
    expect(ceilingForPlan('nope')).toBe(FAIR_USE_DEFAULT_CEILING);
    expect(ceilingForPlan('')).toBe(FAIR_USE_DEFAULT_CEILING);
    expect(Number.isFinite(ceilingForPlan('nope'))).toBe(true);
  });
  it('business ceiling is finite: "unlimited" cannot mean unbounded cost', () => {
    expect(Number.isFinite(ceilingForPlan('business'))).toBe(true);
    expect(ceilingForPlan('business')).toBeGreaterThan(0);
  });
});
