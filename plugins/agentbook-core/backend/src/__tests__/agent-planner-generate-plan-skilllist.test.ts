import { describe, it, expect, vi } from 'vitest';
import { generatePlan } from '../agent-planner';

/**
 * general-question is a conversational answer, not an action: its manifest is
 * INTERNAL with `url: ''`, and its real handling lives in the brain's Step
 * 3a′ (it never reaches _executeClassificationCore's INTERNAL branches). A
 * plan step naming it falls through to the generic HTTP dispatch, fails, and
 * — before #565's confidence fix — was scored as a successful step. The
 * cleaner fix is to never let the planner LLM choose it in the first place:
 * it should not appear in the skills list the prompt offers.
 *
 * simulate-scenario stays in the list — it has an inline handler now.
 */
describe('generatePlan skill list', () => {
  it('does not offer general-question to the planner LLM', async () => {
    let capturedSystem = '';
    const callGemini = vi.fn(async (sys: string) => {
      capturedSystem = sys;
      return '[]';
    });

    const skills = [
      { name: 'record-expense', description: 'Record an expense' },
      { name: 'general-question', description: 'Answer a general question' },
      { name: 'simulate-scenario', description: 'Simulate a what-if scenario' },
    ];

    await generatePlan('do a thing', skills, {}, '', '', callGemini);

    expect(callGemini).toHaveBeenCalled();
    expect(capturedSystem).not.toContain('- general-question:');
    expect(capturedSystem).toContain('- record-expense:');
    expect(capturedSystem).toContain('- simulate-scenario:');
  });
});
