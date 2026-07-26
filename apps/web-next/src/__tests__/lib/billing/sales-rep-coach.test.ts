import { describe, it, expect } from 'vitest';
import { decideRepCoaching, type CoachInput } from '@/lib/billing/sales-rep-coach-logic';

function base(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    commissionBps: 2000,
    metrics: { paidReferrals: 3, commissionsCents: 5000, firstPayout: 0 },
    next: [],
    paidReferralsLast30d: 0,
    freshMilestones: [],
    pendingRecTypes: new Set<string>(),
    ...overrides,
  };
}

describe('decideRepCoaching — message', () => {
  it('encourages toward a near milestone (pct >= 75)', () => {
    const d = decideRepCoaching(base({ next: [{ key: 'referrals_5', label: '5 paying referrals', metric: 'paidReferrals', current: 4, threshold: 5, pct: 80 }] }));
    expect(d.message).toMatch(/almost at "5 paying referrals"/i);
    expect(d.message).toMatch(/1 more paying referral\b/);
  });

  it('praises momentum when there were paid referrals in the last 30 days', () => {
    const d = decideRepCoaching(base({ paidReferralsLast30d: 2 }));
    expect(d.message).toMatch(/momentum/i);
  });

  it('nudges a brand-new rep to land their first referral', () => {
    const d = decideRepCoaching(base({ metrics: { paidReferrals: 0, commissionsCents: 0, firstPayout: 0 } }));
    expect(d.message).toMatch(/first paying referral/i);
  });

  it('re-engages a rep who has referrals but none recently', () => {
    const d = decideRepCoaching(base({ metrics: { paidReferrals: 4, commissionsCents: 8000, firstPayout: 1 }, paidReferralsLast30d: 0 }));
    expect(d.message).toMatch(/quiet month/i);
  });
});

describe('decideRepCoaching — recommendations (queued, never applied)', () => {
  it('proposes a commission raise for a strong performer, stepped and capped at 25%', () => {
    const d = decideRepCoaching(base({ metrics: { paidReferrals: 12, commissionsCents: 40000, firstPayout: 1 }, commissionBps: 2000 }));
    const raise = d.recommendations.find((r) => r.type === 'commission_raise');
    expect(raise?.payload).toMatchObject({ fromBps: 2000, toBps: 2250 });
  });

  it('caps the proposed raise at 2500 bps', () => {
    const d = decideRepCoaching(base({ metrics: { paidReferrals: 30, commissionsCents: 90000, firstPayout: 1 }, commissionBps: 2400 }));
    expect(d.recommendations.find((r) => r.type === 'commission_raise')?.payload.toBps).toBe(2500);
  });

  it('does not propose a raise at/above the cap, or when one is already pending', () => {
    expect(decideRepCoaching(base({ metrics: { paidReferrals: 30, commissionsCents: 90000, firstPayout: 1 }, commissionBps: 2500 })).recommendations.some((r) => r.type === 'commission_raise')).toBe(false);
    expect(decideRepCoaching(base({ metrics: { paidReferrals: 30, commissionsCents: 90000, firstPayout: 1 }, commissionBps: 2000, pendingRecTypes: new Set(['commission_raise']) })).recommendations.some((r) => r.type === 'commission_raise')).toBe(false);
  });

  it('does not propose a raise below the referral threshold', () => {
    expect(decideRepCoaching(base({ metrics: { paidReferrals: 9, commissionsCents: 20000, firstPayout: 1 } })).recommendations.some((r) => r.type === 'commission_raise')).toBe(false);
  });

  it('proposes a reward only on a big fresh milestone (and not if one is pending)', () => {
    expect(decideRepCoaching(base({ freshMilestones: ['referrals_25'] })).recommendations.some((r) => r.type === 'reward')).toBe(true);
    expect(decideRepCoaching(base({ freshMilestones: ['referrals_5'] })).recommendations.some((r) => r.type === 'reward')).toBe(false);
    expect(decideRepCoaching(base({ freshMilestones: ['commissions_1000'], pendingRecTypes: new Set(['reward']) })).recommendations.some((r) => r.type === 'reward')).toBe(false);
  });
});
