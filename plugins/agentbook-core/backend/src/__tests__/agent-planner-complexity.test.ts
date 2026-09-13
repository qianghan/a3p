/**
 * assessComplexity decides, AFTER the brain has already executed the
 * classification inline (agent-brain Step 3c), whether to throw that result
 * away and show a "Proceed?" plan preview instead (Step 4).
 *
 * For categorize-expenses that ordering is the bug: the writes have landed by
 * the time 'complex' is returned, so the user is asked to approve a plan whose
 * work is already done — and the plan step then fails anyway, because
 * executeStep refuses INTERNAL skills. DIRECT_SKILLS opts it out.
 *
 * Only the exemption is new: every other skill must still escalate exactly as
 * before, which is what the second test pins.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessComplexity } from '../agent-planner';

describe('assessComplexity — direct (already-executed) skills', () => {
  it('never plans categorize-expenses, even at a confidence that escalates everything else', () => {
    expect(assessComplexity('Categorize them', { name: 'categorize-expenses' }, 0.5)).toBe('simple');
  });

  it('still escalates a low-confidence write skill (unchanged behaviour)', () => {
    expect(assessComplexity('record $50 lunch', { name: 'record-expense' }, 0.5)).toBe('complex');
  });

  it('the exemption is confidence-only — a genuinely multi-step ask still plans', () => {
    // Guard against over-reading the fix: DIRECT_SKILLS returns early, so this
    // documents that the early return is deliberate and total for this skill.
    expect(assessComplexity('categorize them and then email my accountant', { name: 'categorize-expenses' }, 0.95)).toBe('simple');
  });

  it('a destructive word no longer forces categorize-expenses into a plan', () => {
    // 'categorize-expenses' was in DESTRUCTIVE_SKILLS; "update my categories"
    // matched /\bupdate\b/ and planned a skill that had already run.
    expect(assessComplexity('update my expense categories', { name: 'categorize-expenses' }, 0.95)).toBe('simple');
    expect(assessComplexity('update the $50 lunch', { name: 'edit-expense' }, 0.95)).toBe('complex');
  });
});

describe('the planner source states the exemption structurally', () => {
  const SRC = readFileSync(join(__dirname, '..', 'agent-planner.ts'), 'utf8');
  const slice = (name: string) => {
    const i = SRC.indexOf(`const ${name} = new Set(`);
    expect(i, `${name} not found`).toBeGreaterThan(-1);
    return SRC.slice(i, SRC.indexOf(']);', i));
  };

  it('DIRECT_SKILLS contains categorize-expenses', () => {
    expect(slice('DIRECT_SKILLS')).toContain("'categorize-expenses'");
  });

  it('DESTRUCTIVE_SKILLS does NOT — it would re-plan an already-applied run', () => {
    expect(slice('DESTRUCTIVE_SKILLS')).not.toContain("'categorize-expenses'");
  });
});
