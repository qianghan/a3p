/**
 * Skill precedence is ALPHABETICAL, and that is load-bearing.
 *
 * server.ts selects a skill with `orderBy: { name: 'asc' }` and breaks on the
 * first pattern match. So when two skills both match an utterance, the one whose
 * NAME sorts earlier wins. That is not a routing strategy — it is an accident,
 * and renaming a skill would silently re-route traffic.
 *
 * It produced a real misroute: "how much will I owe in taxes this quarter?"
 * matches manage-bills' broad 'owe ' AND tax-estimate's 'how much.*tax', and
 * manage-bills won purely because m sorts before t. A tax question was answered
 * with accounts payable.
 *
 * Because order can't be relied on, the fix is `excludePatterns` — which is
 * order-independent. These tests pin that, and pin the alphabetical fact itself
 * so the next person reads it here rather than rediscovering it from a bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectSkillByPatterns } from '../skill-routing.js';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';

const SERVER = readFileSync(join(__dirname, '../server.ts'), 'utf8');

function skill(name: string) {
  const s = (BUILT_IN_SKILLS as { name: string }[]).find((x) => x.name === name);
  expect(s, `skill ${name} not found`).toBeTruthy();
  return s as Parameters<typeof selectSkillByPatterns>[0];
}
const matches = (name: string, text: string) =>
  selectSkillByPatterns(skill(name), text, text.toLowerCase());

describe('skill selection is alphabetical — documented, not relied upon', () => {
  it('still selects by name ascending and takes the first match', () => {
    // If this ever changes, the excludePatterns below may be unnecessary — but
    // more importantly, every ambiguous utterance may re-route. Deliberate change
    // only.
    expect(SERVER).toMatch(/orderBy: \{ name: 'asc' \}/);
  });
});

describe('a tax question is not accounts payable', () => {
  const q = 'how much will I owe in taxes this quarter?';

  it('tax-estimate matches it', () => {
    expect(matches('tax-estimate', q)).toBe(true);
  });

  it('manage-bills does NOT, despite its broad "owe" trigger', () => {
    // manage-bills sorts before tax-estimate, so without the exclude it wins.
    expect(matches('manage-bills', q)).toBe(false);
  });

  it('manage-bills still handles genuine payables', () => {
    expect(matches('manage-bills', 'what bills are due this week?')).toBe(true);
    expect(matches('manage-bills', 'what do I owe my suppliers?')).toBe(true);
    expect(matches('manage-bills', 'record a bill from Acme for rent')).toBe(true);
  });
});

describe('a rules question is not a report of the user own data', () => {
  it('tax-deductions does NOT take a definitional question', () => {
    expect(matches('tax-deductions', 'what counts as a business meal deduction?')).toBe(false);
    expect(matches('tax-deductions', 'what qualifies as a home office deduction?')).toBe(false);
  });

  it('tax-deductions still takes questions about the user own deductions', () => {
    // This one must keep working — the fixture was corrected to expect it.
    expect(matches('tax-deductions', 'what deductions can I still claim for last year?')).toBe(true);
    expect(matches('tax-deductions', 'show me my tax savings')).toBe(true);
    expect(matches('tax-deductions', 'is that deductible?')).toBe(true);
  });
});

describe('query-expenses legitimately answers vendor ranking', () => {
  // Not a misroute: query-expenses explicitly claims 'top.*vendor' and its
  // handler sorts spend by vendor and slices the top 5. Asserted so nobody
  // "fixes" the routing on the assumption that vendor-insights must own it.
  it('matches "top 5 vendors"', () => {
    expect(matches('query-expenses', 'show me top 5 vendors this quarter')).toBe(true);
  });

  it('and its handler really does rank vendors', () => {
    expect(SERVER).toMatch(/topVendors[\s\S]{0,200}?slice\(0, 5\)/);
    expect(SERVER).toMatch(/Top spending:/);
  });
});
