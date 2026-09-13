import { describe, it, expect } from 'vitest';
import { assessStepQuality } from '../agent-evaluator';

const step = (data: unknown) => ({
  id: 's1', action: 'categorize-expenses', description: 'categorize', params: {}, dependsOn: [],
  canUndo: false, status: 'done' as const, result: { success: true, data },
});

describe('evaluator reads the structured categorize outcome', () => {
  it('scores applied/total and names the skipped count', () => {
    const q = assessStepQuality(step({ total: 26, applied: [1, 2], pending: [], skipped: Array(24).fill({}) }));
    expect(q.score).toBeCloseTo(2 / 26, 3);
    expect(q.issues.join(' ')).toContain('24');
  });
  it('is a clean 1.0 when there was nothing to do', () => {
    expect(assessStepQuality(step({ total: 0, applied: [], pending: [], skipped: [] })).score).toBe(1);
  });
});
