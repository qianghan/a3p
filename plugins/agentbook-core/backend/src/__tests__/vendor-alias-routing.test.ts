import { describe, it, expect } from 'vitest';
import { selectSkillByPatterns } from '../skill-routing';
import { BUILT_IN_SKILLS } from '../built-in-skills';
import { triageTurn } from '../consultation-triage';

/**
 * "SBUX is Starbucks" — the last canonical failure, and not a bug.
 *
 * cu-alex-070b has failed every eval run today, and the reason turned out to
 * be that the capability does not exist: no skill, no model field, no handler
 * anywhere in the tree. The fixture asserted a feature nobody had built.
 *
 * It is worth building. Bank feeds emit SBUX, AMZN MKTP, SQ *COFFEE, and every
 * report the user reads inherits those strings. Saying it once, in passing, is
 * the natural fix.
 *
 * The routing risk is that "X is Y" is also how people say "this is fine", so
 * the trigger is loose BY DESIGN and the database is the real guard: the
 * inline handler renames only when a vendor with that normalized name exists,
 * and otherwise returns null to fall through. These tests cover the routing
 * half; the handler's DB check is exercised against production.
 */
// selectSkillByPatterns is a per-skill PREDICATE (skill, text, lower), not a
// selector. Mirror how the router uses it: first skill whose patterns claim
// the utterance, in array order.
const skills = BUILT_IN_SKILLS as Array<Record<string, unknown>>;
const claimants = (t: string) =>
  skills.filter((s) => selectSkillByPatterns(s as never, t, t.toLowerCase()))
    .map((s) => s.name as string);
const route = (t: string) => claimants(t)[0] ?? null;

describe('the alias utterance reaches the alias skill', () => {
  it('routes "SBUX is Starbucks"', () => {
    expect(route('SBUX is Starbucks')).toBe('set-vendor-alias');
  });

  it('routes the explicit forms too', () => {
    expect(route('rename SBUX to Starbucks')).toBe('set-vendor-alias');
    expect(route('vendor AMZN MKTP is Amazon')).toBe('set-vendor-alias');
  });

  it('is the ONLY claimant, so routing does not depend on skill order', () => {
    // Production iterates skills in DB order, not BUILT_IN_SKILLS order. If two
    // skills both claimed this, which one won would be incidental — that is
    // precisely the bug #427 fixed for a different utterance. One claimant
    // makes the route independent of ordering.
    expect(claimants('SBUX is Starbucks')).toEqual(['set-vendor-alias']);
    expect(claimants('rename SBUX to Starbucks')).toEqual(['set-vendor-alias']);
    expect(claimants('paid $42 at SBUX')).toEqual(['record-expense']);
  });

  it('stays on the skill path rather than diverting to consultation', () => {
    // A three-word statement with no interrogative is quick capture, and the
    // advisor cannot rename anything.
    expect(triageTurn('SBUX is Starbucks').kind).toBe('transactional');
  });
});

describe('it does not swallow ordinary sentences shaped like "X is Y"', () => {
  // The loose trigger is the whole risk. Excludes catch the obvious ones; the
  // handler's vendor lookup catches the rest by falling through.
  it.each([
    'this is fine',
    'that is wrong',
    'it is personal',
    'everything is correct',
    'the receipt is ready',
  ])('does not claim: %s', (t) => {
    expect(route(t)).not.toBe('set-vendor-alias');
  });

  it('does not claim a question', () => {
    expect(route('what is depreciation?')).not.toBe('set-vendor-alias');
    expect(route('what is my cash balance?')).not.toBe('set-vendor-alias');
  });

  it('does not outrank recording an actual expense', () => {
    // "paid $42 at SBUX" is turn one of the same thread and must still book.
    expect(route('paid $42 at SBUX')).toBe('record-expense');
  });
});

describe('the skill is registered coherently', () => {
  const skill = (BUILT_IN_SKILLS as Array<Record<string, unknown>>)
    .find((s) => s.name === 'set-vendor-alias');

  it('exists with trigger and exclude patterns', () => {
    expect(skill, 'set-vendor-alias must be in BUILT_IN_SKILLS').toBeTruthy();
    expect((skill!.triggerPatterns as string[]).length).toBeGreaterThan(0);
    expect(
      (skill!.excludePatterns as string[]).length,
      'a trigger this loose without excludes would rename on "this is fine"',
    ).toBeGreaterThan(0);
  });

  it('every pattern is a valid regex', () => {
    // A malformed pattern here throws at routing time for EVERY utterance,
    // not just this skill's.
    for (const p of [...(skill!.triggerPatterns as string[]), ...(skill!.excludePatterns as string[])]) {
      expect(() => new RegExp(p, 'i'), `bad pattern: ${p}`).not.toThrow();
    }
  });
});
