import { describe, it, expect } from 'vitest';
import { selectSkillByPatterns } from '../skill-routing';
import { BUILT_IN_SKILLS } from '../built-in-skills';

/**
 * Chinese messages were routed by an LLM guess, not by the router.
 *
 * There were ZERO Chinese trigger patterns across all 85 skills, so every
 * Chinese utterance fell past Stage-2 regex matching to Stage-3, where an LLM
 * picks from 85 English descriptions. That is non-deterministic, and it picked
 * wrong on production:
 *
 *   这个月我花了多少钱？  → query-finance ("business or personal?"), not query-expenses
 *   谁欠我钱？            → aging-report (right, by luck)
 *
 * The docs and guides ship in Chinese; the router did not. This adds Chinese
 * triggers to the skills covering the documented Chinese journeys, using the
 * SAME manifest mechanism English uses — not a translation pre-pass, which
 * would put an LLM round-trip on the hot path and turn a translation error into
 * a routing error.
 *
 * Scoped deliberately to high-traffic skills. Patterns for all 85 would be
 * unbounded maintenance and unbounded stealing risk — and stealing is the real
 * hazard here (#427, #442, and the triage change that took the eval from
 * 97.5% to 80%). Every case below therefore asserts the SOLE claimant, so a
 * pattern that reaches too far fails rather than silently outranking a peer.
 */

// selectSkillByPatterns is a per-skill PREDICATE (skill, text, lower). The
// router tries skills in name order and takes the first match, which is why
// the sole-claimant assertion matters more than the first-match one.
const skills = [...BUILT_IN_SKILLS].sort((a, b) =>
  String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
) as Array<Record<string, unknown>>;

const claimants = (t: string) =>
  skills.filter((s) => selectSkillByPatterns(s as never, t, t.toLowerCase())).map((s) => s.name as string);
const route = (t: string) => claimants(t)[0] ?? null;

describe('Chinese utterances route deterministically, without the LLM', () => {
  it.each([
    ['这个月我花了多少钱？', 'query-expenses'],
    ['我今年的支出是多少', 'query-expenses'],
    ['显示我这个月的支出', 'query-expenses'],
    ['谁欠我钱？', 'aging-report'],
    ['我有多少未付发票', 'aging-report'],
    ['记录 42 元咖啡', 'record-expense'],
    ['花了 88 块加油', 'record-expense'],
    ['给 Acme 开一张 500 元的发票', 'create-invoice'],
    ['我应该预留多少税款', 'tax-estimate'],
    ['支出分类明细', 'expense-breakdown'],
  ])('%s → %s', (t, want) => expect(route(t)).toBe(want));

  it('each Chinese utterance has exactly one claimant', () => {
    // The real hazard: a pattern broad enough to also claim a peer's traffic.
    // Two claimants means which one wins is incidental — the #427 bug.
    for (const t of [
      '这个月我花了多少钱？', '谁欠我钱？', '记录 42 元咖啡',
      '给 Acme 开一张 500 元的发票', '我应该预留多少税款', '支出分类明细',
    ]) {
      expect(claimants(t), `${t} has ${claimants(t).length} claimants`).toHaveLength(1);
    }
  });
});

describe('English routing is untouched', () => {
  // Adding Chinese must not shift a single English decision. These are the
  // exact utterances the canonical eval asserts.
  it.each([
    ['Spent $42 at Starbucks for client meeting today', 'record-expense'],
    ['paid AWS $1240 for hosting', 'record-expense'],
    ['how much did I spend on travel last month?', 'query-expenses'],
    ['who owes me money?', 'aging-report'],
    ['invoice TechCorp $5000 for January consulting', 'create-invoice'],
  ])('%s → %s', (t, want) => expect(route(t)).toBe(want));
});

describe('the patterns do not reach past their own job', () => {
  it('a Chinese rules question is not claimed by a data skill', () => {
    // These belong to consultation, which triage routes before the router runs.
    // If a data skill claims them, the advisory path is unreachable in Chinese.
    for (const t of ['我可以抵扣家庭办公室吗？', '今年的税率是多少？', '自雇人士有什么规定？']) {
      const c = claimants(t);
      expect(c.filter((n) => n !== 'general-question'), `${t} claimed by ${c.join(',')}`).toEqual([]);
    }
  });

  it('every pattern is a valid regex', () => {
    // A malformed pattern throws at routing time for EVERY utterance.
    for (const s of skills) {
      for (const p of [
        ...((s.triggerPatterns as string[]) ?? []),
        ...((s.excludePatterns as string[]) ?? []),
        ...((s.requirePatterns as string[]) ?? []),
      ]) {
        expect(() => new RegExp(p, 'i'), `bad pattern on ${s.name}: ${p}`).not.toThrow();
      }
    }
  });
});
