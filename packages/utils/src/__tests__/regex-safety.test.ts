import { describe, it, expect } from 'vitest';
import { assessUserRegex, MAX_PATTERN_LENGTH } from '../regex-safety.js';

/**
 * Accepting a regex from outside.
 *
 * The patterns this guards are STORED and then run against every message a
 * user sends, so one bad registration is a permanent denial of service set
 * off by ordinary traffic. Compiling the pattern — which is what the skill
 * registration route used to do — proves only that it is syntactically
 * valid, and `(a+)+$` is perfectly valid.
 */

describe('it accepts the patterns a real skill would register', () => {
  it.each([
    'record (an? )?expense',
    '\\b(invoice|bill)\\b',
    'how much (did|have) I (spend|spent)',
    '^\\/start$',
    '(?:coffee|lunch|dinner) (?:with|at) (.+)',
    '\\d{1,3}(?:[.,]\\d{2})?\\s?(?:usd|aud|cad)',
  ])('accepts %s', (p) => {
    expect(assessUserRegex(p)).toEqual({ safe: true });
  });
});

describe('it rejects the shapes that blow up', () => {
  it.each([
    ['(a+)+$', 'the textbook nested quantifier'],
    ['(a|a)+$', 'ambiguous alternation under a quantifier'],
    ['(a*)*$', 'nested star'],
    ['^(\\w+\\s?)+$', 'the shape that actually shipped here in #489'],
  ])('rejects %s — %s', (p) => {
    const v = assessUserRegex(p);
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/backtrack/i);
  });

  it('measures a FAILING match, which is the only kind that blows up', () => {
    // A succeeding match returns on the first path the engine tries and is
    // fast however bad the pattern is. Every probe here must end in a
    // character the pattern cannot accept, or the check proves nothing.
    const evil = '(a+)+$';
    const succeeds = Date.now();
    new RegExp(evil).test('a'.repeat(24));
    expect(Date.now() - succeeds).toBeLessThan(50); // fast, and meaningless
    expect(assessUserRegex(evil).safe).toBe(false); // the guard still catches it
  });
});

describe('the cheap checks', () => {
  it('rejects a pattern that does not compile', () => {
    expect(assessUserRegex('([a-z').reason).toMatch(/not a valid/);
  });

  it('rejects an empty or non-string pattern', () => {
    expect(assessUserRegex('').safe).toBe(false);
    expect(assessUserRegex(undefined as unknown as string).safe).toBe(false);
  });

  it('caps the length before running anything', () => {
    const v = assessUserRegex('a'.repeat(MAX_PATTERN_LENGTH + 1));
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(new RegExp(String(MAX_PATTERN_LENGTH)));
  });
});

describe('it does not reject a pattern merely for being slow-ish', () => {
  it('accepts a long but linear pattern', () => {
    // Linear time at any speed is fine — a guard that fires on "slow" rather
    // than on "explosive" rejects legitimate patterns and gets removed.
    const linear = '(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta){1,4}';
    expect(assessUserRegex(linear)).toEqual({ safe: true });
  });
});
