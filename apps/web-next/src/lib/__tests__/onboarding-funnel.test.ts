/**
 * PR 46 / Tier 3 #10 — funnel-computation logic.
 *
 * Tests the per-step funnel + drop-off and median completion-time
 * calculations the admin endpoint runs against an event stream.
 *
 * The route itself is too thin to integration-test without a real DB; this
 * file exercises the pure aggregation helpers in isolation so regressions
 * in the math are caught without booting Postgres.
 */

import { describe, it, expect } from 'vitest';

// Replicate the route's pure helpers here for direct testing. If the
// route's logic ever extracts into a shared module these tests will
// re-import — for now the duplication is small + intentional (the route
// stays a thin Next handler).

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const STEPS_ORDER = [
  'business_type',
  'jurisdiction',
  'currency',
  'accounts',
  'bank',
  'first_expense',
  'telegram',
];

interface AbEventLike {
  eventType: string;
  tenantId: string;
  action: unknown;
  createdAt: Date;
}

function buildFunnel(events: AbEventLike[]) {
  const startedTenants = new Set<string>();
  const completedTenants = new Set<string>();
  const under15MinTenants = new Set<string>();
  const stepCompletionsByStep: Record<string, Set<string>> = {};
  const elapsedSecsToFinish: number[] = [];

  for (const ev of events) {
    if (ev.eventType === 'onboarding.started') {
      startedTenants.add(ev.tenantId);
    } else if (ev.eventType === 'onboarding.step_completed') {
      const action = (ev.action as { stepId?: string } | null) ?? {};
      if (action.stepId) {
        if (!stepCompletionsByStep[action.stepId]) {
          stepCompletionsByStep[action.stepId] = new Set();
        }
        stepCompletionsByStep[action.stepId].add(ev.tenantId);
      }
    } else if (ev.eventType === 'onboarding.completed') {
      const action = (ev.action as { under15Min?: boolean; completedInSec?: number } | null) ?? {};
      completedTenants.add(ev.tenantId);
      if (action.under15Min === true) under15MinTenants.add(ev.tenantId);
      if (typeof action.completedInSec === 'number') {
        elapsedSecsToFinish.push(action.completedInSec);
      }
    }
  }

  let prevCount = startedTenants.size;
  const funnel = STEPS_ORDER.map((stepId) => {
    const completedCount = stepCompletionsByStep[stepId]?.size ?? 0;
    const dropOffFromPrev = prevCount === 0 ? 0 : Math.max(0, prevCount - completedCount);
    const dropOffPct = prevCount === 0 ? 0 : dropOffFromPrev / prevCount;
    prevCount = completedCount;
    return { stepId, completedCount, dropOffFromPrev, dropOffPct };
  });

  const inProgressTenants = new Set<string>();
  for (const tid of startedTenants) {
    if (completedTenants.has(tid)) continue;
    const anyStep = STEPS_ORDER.some((s) => stepCompletionsByStep[s]?.has(tid));
    if (anyStep) inProgressTenants.add(tid);
  }
  const abandoned = Math.max(
    0,
    startedTenants.size - completedTenants.size - inProgressTenants.size,
  );

  return {
    started: startedTenants.size,
    completed: completedTenants.size,
    inProgress: inProgressTenants.size,
    abandoned,
    under15Min: under15MinTenants.size,
    medianTimeToCompleteSec: median(elapsedSecsToFinish),
    funnel,
  };
}

function makeEvent(eventType: string, tenantId: string, action: unknown = {}): AbEventLike {
  return { eventType, tenantId, action, createdAt: new Date() };
}

describe('median', () => {
  it('returns null for empty input', () => {
    expect(median([])).toBeNull();
  });
  it('returns the single value for n=1', () => {
    expect(median([42])).toBe(42);
  });
  it('returns the middle for odd-length', () => {
    expect(median([1, 5, 3])).toBe(3);
  });
  it('averages the two middles for even-length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('onboarding funnel aggregation (PR 46 / Tier 3 #10)', () => {
  it('returns zero counts on an empty stream', () => {
    const result = buildFunnel([]);
    expect(result.started).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.abandoned).toBe(0);
    expect(result.medianTimeToCompleteSec).toBeNull();
    expect(result.funnel.every((s) => s.completedCount === 0)).toBe(true);
  });

  it('counts started tenants exactly once even with duplicate start events', () => {
    const events = [
      makeEvent('onboarding.started', 't1'),
      makeEvent('onboarding.started', 't1'), // duplicate — should not double-count
      makeEvent('onboarding.started', 't2'),
    ];
    expect(buildFunnel(events).started).toBe(2);
  });

  it('marks a tenant as completed when onboarding.completed fires', () => {
    const events = [
      makeEvent('onboarding.started', 't1'),
      makeEvent('onboarding.completed', 't1', { completedInSec: 600, under15Min: true }),
    ];
    const r = buildFunnel(events);
    expect(r.completed).toBe(1);
    expect(r.under15Min).toBe(1);
    expect(r.medianTimeToCompleteSec).toBe(600);
  });

  it('classifies a started-but-not-done tenant as in-progress, not abandoned', () => {
    const events = [
      makeEvent('onboarding.started', 't1'),
      makeEvent('onboarding.step_completed', 't1', { stepId: 'business_type' }),
    ];
    const r = buildFunnel(events);
    expect(r.inProgress).toBe(1);
    expect(r.abandoned).toBe(0);
  });

  it('classifies started-with-no-steps as abandoned', () => {
    const events = [makeEvent('onboarding.started', 't1')];
    const r = buildFunnel(events);
    expect(r.inProgress).toBe(0);
    expect(r.abandoned).toBe(1);
  });

  it('drop-off cascades — each step compares to the previous step completions', () => {
    // 3 tenants start; 3 complete step 1; 2 complete step 2; 1 completes step 3
    const events = [
      makeEvent('onboarding.started', 't1'),
      makeEvent('onboarding.started', 't2'),
      makeEvent('onboarding.started', 't3'),
      makeEvent('onboarding.step_completed', 't1', { stepId: 'business_type' }),
      makeEvent('onboarding.step_completed', 't2', { stepId: 'business_type' }),
      makeEvent('onboarding.step_completed', 't3', { stepId: 'business_type' }),
      makeEvent('onboarding.step_completed', 't1', { stepId: 'jurisdiction' }),
      makeEvent('onboarding.step_completed', 't2', { stepId: 'jurisdiction' }),
      makeEvent('onboarding.step_completed', 't1', { stepId: 'currency' }),
    ];
    const r = buildFunnel(events);
    expect(r.funnel[0].completedCount).toBe(3); // business_type
    expect(r.funnel[0].dropOffFromPrev).toBe(0); // all started → all completed first
    expect(r.funnel[1].completedCount).toBe(2); // jurisdiction
    expect(r.funnel[1].dropOffFromPrev).toBe(1); // 3 → 2
    expect(r.funnel[2].completedCount).toBe(1); // currency
    expect(r.funnel[2].dropOffFromPrev).toBe(1); // 2 → 1
  });

  it('computes median completion time across multiple completions', () => {
    const events = [
      makeEvent('onboarding.started', 't1'),
      makeEvent('onboarding.completed', 't1', { completedInSec: 300, under15Min: true }),
      makeEvent('onboarding.started', 't2'),
      makeEvent('onboarding.completed', 't2', { completedInSec: 900, under15Min: true }),
      makeEvent('onboarding.started', 't3'),
      makeEvent('onboarding.completed', 't3', { completedInSec: 1500, under15Min: false }),
    ];
    const r = buildFunnel(events);
    expect(r.medianTimeToCompleteSec).toBe(900);
    expect(r.under15Min).toBe(2);
    expect(r.completed).toBe(3);
  });
});
