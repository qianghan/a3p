import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeStep } from '../agent-planner';

/**
 * Every skill manifest whose endpoint is `{ method: 'INTERNAL' }`
 * (categorize-expenses, daily-briefing, personal-snapshot, …) has no HTTP
 * route to call — the handler lives inline in `_executeClassificationCore`.
 * `executeStep` used to answer those with
 * `Skill "X" is internal and cannot be executed via HTTP`, so ANY multi-step
 * plan containing one failed at that step. The single-step confirm path only
 * looked healthy because it bypasses the planner entirely
 * (the `pendingClassification` branch in agent-brain.ts).
 *
 * The planner must not learn how to run skills itself — it takes a runner
 * from the brain, which already owns an executor.
 */
const step = {
  id: 's1',
  action: 'categorize-expenses',
  description: 'Categorize uncategorized expenses',
  params: {},
  dependsOn: [],
  canUndo: false,
  status: 'pending' as const,
};
const skills = [{ name: 'categorize-expenses', endpoint: { method: 'INTERNAL', url: '' } }];

describe('executeStep with an INTERNAL skill', () => {
  it('delegates to runInternal and returns its result', async () => {
    const runInternal = vi.fn(async () => ({
      success: true,
      data: { total: 3, applied: [1, 2, 3], pending: [], skipped: [] },
      message: 'Categorized 3 of 3',
    }));
    const r = await executeStep(step as any, 't1', skills as any, {}, runInternal);
    expect(runInternal).toHaveBeenCalledWith('categorize-expenses', {});
    expect(r.success).toBe(true);
    expect(r.data?.total).toBe(3);
    expect(r.message).toBe('Categorized 3 of 3');
  });

  it('passes the step params through to the runner', async () => {
    const runInternal = vi.fn(async () => ({ success: true, data: {} }));
    await executeStep(
      { ...step, params: { month: '2026-08' } } as any,
      't1',
      skills as any,
      {},
      runInternal,
    );
    expect(runInternal).toHaveBeenCalledWith('categorize-expenses', { month: '2026-08' });
  });

  it('fails clearly when no runner was supplied', async () => {
    const r = await executeStep(step as any, 't1', skills as any, {});
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('internal');
    // The old message claimed HTTP was the only way to run it — it is not.
    expect(String(r.error)).not.toContain('cannot be executed via HTTP');
  });

  it('does not route an INTERNAL skill through the HTTP path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
    const runInternal = vi.fn(async () => ({ success: true, data: {} }));
    await executeStep(step as any, 't1', skills as any, { '/api/v1/': 'http://x' }, runInternal);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

/**
 * Wiring half. The behaviour above passes on a brain that never supplies a
 * runner, which is exactly the state this task fixes — so assert the call
 * site too. Source-level on purpose: the plan-step loop sits behind a
 * confirm-flow + DB session that a unit test would have to fake wholesale,
 * and a mocked executor would go green against a reverted call site.
 */
const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');

/** The single `executeStep(` call in the plan-step loop, with its runner. */
const CALL_SLICE = (() => {
  const start = BRAIN.indexOf('await executeStep(step, tenantId, ctx.skills, ctx.baseUrls');
  expect(start).toBeGreaterThan(-1);
  // Up to the line that consumes the result — the whole call expression,
  // however long the runner grows.
  const end = BRAIN.indexOf('step.result = result;', start);
  expect(end).toBeGreaterThan(start);
  return BRAIN.slice(start, end);
})();

describe('agent-brain hands the planner an INTERNAL runner', () => {
  it('passes a 5th argument to executeStep', () => {
    expect(CALL_SLICE).toMatch(/await executeStep\(step, tenantId, ctx\.skills, ctx\.baseUrls,\s*async \(/);
  });

  it('runs the step through ctx.executeClassification', () => {
    expect(CALL_SLICE).toContain('ctx.executeClassification(');
  });

  it("uses the session's original request as the text, not the bare confirm word", () => {
    // The executor derives the reply locale from `text`. Handing it "yes"
    // (or "oui") throws away the language of the request that built the plan.
    expect(CALL_SLICE).toMatch(/activeSession\.trigger/);
  });

  it('supplies the tenant config itself, read once per plan', () => {
    // executeClassification -> _executeClassificationCore does NOT re-fetch
    // AbTenantConfig when `tenantConfig === undefined` (only classifyOnly
    // does); leaving it undefined silently defaults every amount to en-US/USD.
    // The read belongs ABOVE the step loop — inside the runner it repeated the
    // same query once per step for a row that cannot change mid-plan.
    expect(CALL_SLICE).toMatch(/tenantConfig: planTenantConfig/);
    expect(CALL_SLICE).not.toMatch(/tenantConfig: undefined/);
    expect(CALL_SLICE).not.toMatch(/abTenantConfig\s*\.\s*findFirst/);
    const hoist = BRAIN.indexOf('const planTenantConfig = await db.abTenantConfig');
    const loop = BRAIN.indexOf('for (let i = startStep; i < plan.length; i++)');
    expect(hoist).toBeGreaterThan(-1);
    expect(hoist).toBeLessThan(loop);
  });

  it('maps the executor result through mapInternalRunResult', () => {
    // The inline `success: Boolean(r.responseData || r.skillResponse?.success)`
    // was true for every core return, failures included. See
    // agent-brain-no-session-action.test.ts for the mapping's own cases.
    expect(CALL_SLICE).toMatch(/return mapInternalRunResult\(r\)/);
    expect(CALL_SLICE).not.toMatch(/Boolean\(r\?\.responseData/);
  });
});
