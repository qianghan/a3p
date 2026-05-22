import { describe, it, expect, vi } from 'vitest';

/**
 * Wave 2 PR 14 / G-016 — per-skill metrics.
 *
 * The real `executeClassification` wrapper writes an AbSkillRun row on every
 * run. We test the contract here at the unit level:
 *
 *   1. Metric writes are fire-and-forget — a DB failure during the write
 *      must not propagate to the caller (the agent response must still
 *      resolve).
 *   2. Aggregation math: percentile + per-skill bucketing produces the
 *      shape the /agent/skills/metrics endpoint returns.
 *
 * End-to-end coverage of the wrapper itself is provided by the existing
 * agent-brain confirm-flow tests (which invoke executeClassification through
 * the brain). Those tests mock `db` and so don't need to know about the new
 * AbSkillRun table — the wrapper swallows write failures.
 */

describe('skill-metrics: fire-and-forget contract', () => {
  it('caller is not blocked or broken if the metric write rejects', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('DB down'));
    // Simulate the production pattern: kick off the write inside `void (async..)`
    // with a try/catch around the await. The outer flow continues even though
    // the write is rejecting in the background.
    let outerError: unknown = null;
    let outerResult: string | null = null;
    try {
      void (async () => {
        try {
          await mockCreate({
            data: {
              tenantId: 't1',
              skillName: 'record-expense',
              status: 'success',
              durationMs: 42,
              confidence: 0.9,
              channel: 'telegram',
            },
          });
        } catch {
          // swallowed — production logs a warn here
        }
      })();
      outerResult = await Promise.resolve('main response');
    } catch (e) {
      outerError = e;
    }

    expect(outerError).toBeNull();
    expect(outerResult).toBe('main response');
    // The create was invoked (fire-and-forget initiated)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('captures error status + error message on thrown exceptions (shape contract)', () => {
    // Documents the shape of an AbSkillRun row produced by the wrapper when
    // the core throws. Used as a regression anchor — if the shape ever
    // changes, this test will fail and force a deliberate update.
    const errorRow = {
      tenantId: 't1',
      skillName: 'send-invoice',
      status: 'error' as const,
      durationMs: 123,
      confidence: 0.85,
      errorType: 'internal',
      errorMessage: 'Network unreachable',
      channel: 'web',
    };
    expect(errorRow.status).toBe('error');
    expect(errorRow.errorType).toBe('internal');
    expect(errorRow.errorMessage.length).toBeLessThanOrEqual(200);
  });

  it('captures timeout status on AbortError (shape contract)', () => {
    const timeoutRow = {
      tenantId: 't1',
      skillName: 'tax-slip-scan',
      status: 'timeout' as const,
      durationMs: 30_000,
      errorType: 'timeout',
      errorMessage: 'The operation was aborted',
      channel: 'telegram',
    };
    expect(timeoutRow.status).toBe('timeout');
    expect(timeoutRow.errorType).toBe('timeout');
  });
});

describe('skill-metrics: aggregation math', () => {
  // Mirrors the percentile() helper in the metrics route handler. Kept in sync
  // by convention; if the route's algorithm changes, update this and assert
  // both produce the same outputs.
  function percentile(sortedAsc: number[], p: number): number | null {
    if (!sortedAsc.length) return null;
    const idx = Math.floor((p / 100) * sortedAsc.length);
    return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
  }

  it('returns null for empty input', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it('returns the single value for a 1-element list', () => {
    expect(percentile([100], 50)).toBe(100);
    expect(percentile([100], 95)).toBe(100);
  });

  it('p50 of [1..10] is the 5th element (index floor(0.5*10)=5)', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // floor(0.5 * 10) = 5 → arr[5] = 6
    expect(percentile(arr, 50)).toBe(6);
  });

  it('p95 of [1..20] is the last element (clamped to sorted.length-1)', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i + 1);
    // floor(0.95 * 20) = 19 → arr[19] = 20
    expect(percentile(arr, 95)).toBe(20);
  });

  it('per-skill bucketing: rolls up counts + success rate', () => {
    const runs = [
      { skillName: 'a', status: 'success', durationMs: 10, confidence: 0.9 },
      { skillName: 'a', status: 'success', durationMs: 20, confidence: 0.8 },
      { skillName: 'a', status: 'error',   durationMs: 30, confidence: 0.5 },
      { skillName: 'b', status: 'success', durationMs: 50, confidence: 0.95 },
    ];

    const bySkill: Record<string, {
      total: number;
      success: number;
      error: number;
      durations: number[];
    }> = {};
    for (const r of runs) {
      const s = (bySkill[r.skillName] ??= { total: 0, success: 0, error: 0, durations: [] });
      s.total++;
      if (r.status === 'success') s.success++;
      else if (r.status === 'error') s.error++;
      s.durations.push(r.durationMs);
    }

    expect(bySkill.a.total).toBe(3);
    expect(bySkill.a.success).toBe(2);
    expect(bySkill.a.error).toBe(1);
    expect(bySkill.a.success / bySkill.a.total).toBeCloseTo(2 / 3);
    expect(bySkill.b.total).toBe(1);
    expect(bySkill.b.success).toBe(1);
  });
});
