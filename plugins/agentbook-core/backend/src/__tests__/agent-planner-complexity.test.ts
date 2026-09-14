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

/**
 * A low classifier score is a PRE-execution signal. agent-brain Step 3b
 * (shouldEscalateOnConfidence, threshold 0.55) is the deliberate gate for it.
 * Step 4 calls assessComplexity again on the ALREADY-EXECUTED result, and any
 * score in [0.55, 0.6) fell through 3b and then tripped the 0.6 rule here —
 * so a read-only one-word question ("Expenses") came back as "Here's my plan:
 * 1. Retrieve a list of all expenses / Proceed? (yes/no)", a preview offering
 * to redo work the user had already paid for.
 */
describe('assessComplexity — afterExecution disables the confidence rule only', () => {
  it('a [0.55, 0.6) score does not turn an executed answer into a plan', () => {
    expect(assessComplexity('Expenses', { name: 'some-skill' }, 0.58, { afterExecution: true })).toBe('simple');
  });

  it('the same score still escalates BEFORE execution (Step 3b behaviour preserved)', () => {
    expect(assessComplexity('Expenses', { name: 'some-skill' }, 0.58)).toBe('complex');
  });

  it('the text-based rules stay live after execution for READ-ONLY skills', () => {
    // The planner may legitimately add steps for what the TEXT asks, as long
    // as nothing has been written yet. query-estimates is deliberate: it is in
    // none of REPORTING_SKILLS / DIRECT_SKILLS / DESTRUCTIVE_SKILLS, so only
    // the text rules decide it.
    expect(assessComplexity('estimates and then email my accountant', { name: 'query-estimates' }, 0.95, { afterExecution: true })).toBe('complex');
    expect(assessComplexity('if it is over $50 then show it', { name: 'query-estimates' }, 0.95, { afterExecution: true })).toBe('complex');
  });
});

/**
 * A write that already landed is never re-planned.
 *
 * record-expense / create-invoice are in DESTRUCTIVE_SKILLS but ship with
 * confirmBefore: false, so Step 3c executes them. Step 4 then re-assessed the
 * SAME text, the destructive-word rule matched the word that caused the write
 * ("add", "record", "create"), and the brain replaced a finished expense with
 * "Here's my plan ... Proceed?" — whose confirmation re-runs the POST. Two
 * expenses for one sentence.
 *
 * These assertions deliberately REPLACE ones that pinned 'complex' for a
 * destructive skill under afterExecution: they pinned the hazard.
 */
describe('assessComplexity — afterExecution never re-plans a completed write', () => {
  it('a destructive word on an executed write skill is simple', () => {
    expect(assessComplexity('add a $40 lunch', { name: 'record-expense' }, 0.9, { afterExecution: true })).toBe('simple');
    expect(assessComplexity('delete the $50 lunch', { name: 'edit-expense' }, 0.95, { afterExecution: true })).toBe('simple');
    expect(assessComplexity('create an invoice for Acme', { name: 'create-invoice' }, 0.9, { afterExecution: true })).toBe('simple');
  });

  it('the pre-execution behaviour is unchanged — the same call still plans', () => {
    expect(assessComplexity('add a $40 lunch', { name: 'record-expense' }, 0.9)).toBe('complex');
    expect(assessComplexity('delete the $50 lunch', { name: 'edit-expense' }, 0.95)).toBe('complex');
  });

  it('multi-intent text whose first intent already wrote is not re-planned', () => {
    // The write is done; planning now would offer to do it a second time.
    expect(assessComplexity('log it and then email my accountant', { name: 'record-expense' }, 0.9, { afterExecution: true })).toBe('simple');
    // ...but the same text before execution still plans.
    expect(assessComplexity('log it and then email my accountant', { name: 'record-expense' }, 0.9)).toBe('complex');
  });

  it('a confirmBefore skill is likewise never re-planned after execution', () => {
    // Unreachable in prod (Step 3a gates confirmBefore before any execution),
    // but the rule must not depend on that: a plan preview after a write is
    // always wrong.
    expect(assessComplexity('Expenses', { name: 'some-skill', confirmBefore: true }, 0.95, { afterExecution: true })).toBe('simple');
    expect(assessComplexity('Expenses', { name: 'some-skill', confirmBefore: true }, 0.95)).toBe('complex');
  });

  it('a read-only multi-intent ask may still be planned after execution', () => {
    expect(assessComplexity('estimates and then invoices', { name: 'query-estimates' }, 0.9, { afterExecution: true })).toBe('complex');
  });
});

describe('read-only invoicing lookups are never plan-gated', () => {
  // GET /api/v1/agentbook-invoice/invoices and GET .../aging-report are both
  // findMany + arithmetic — no writes on either the Express or the Next route.
  // The bare-topic shortcut routes "invoices"/"receivables" to them, so a
  // one-word question must not be answered with a plan preview.
  it.each([
    ['Invoices', 'query-invoices'],
    ['receivables', 'aging-report'],
  ])('%s → %s stays simple at a low score', (text, skill) => {
    expect(assessComplexity(text, { name: skill }, 0.4)).toBe('simple');
  });
});
