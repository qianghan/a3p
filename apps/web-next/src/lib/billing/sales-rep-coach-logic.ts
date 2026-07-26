import type { RepMetrics, MilestoneProgress } from './sales-rep-milestones';

/**
 * Pure decision logic for the rep-coach — which message to send and which
 * money actions to propose. Kept free of server-only / DB imports so it is
 * trivially unit-testable; the IO runner lives in sales-rep-coach.ts.
 */

const RAISE_REFERRAL_THRESHOLD = 10; // strong performer
const RAISE_STEP_BPS = 250; // +2.5 percentage points
const RAISE_CAP_BPS = 2500; // never auto-propose above 25%
const BIG_MILESTONES = new Set(['referrals_25', 'commissions_1000']);

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export interface CoachRecommendation {
  type: 'commission_raise' | 'reward';
  payload: Record<string, unknown>;
  reason: string;
}

export interface CoachDecision {
  message: string | null;
  recommendations: CoachRecommendation[];
}

export interface CoachInput {
  commissionBps: number;
  metrics: RepMetrics;
  next: MilestoneProgress['next'];
  paidReferralsLast30d: number;
  freshMilestones: string[]; // keys crossed on this run
  pendingRecTypes: Set<string>; // recommendation types already pending for this rep
}

export function decideRepCoaching(input: CoachInput): CoachDecision {
  const { commissionBps, metrics, next, paidReferralsLast30d, freshMilestones, pendingRecTypes } = input;

  // ── Message (pick the single most relevant; a coach reaches out weekly) ──
  let message: string | null;
  const nearMilestone = next.find((n) => n.pct >= 75 && n.pct < 100);
  if (nearMilestone) {
    const remaining = nearMilestone.metric === 'commissionsCents'
      ? `${money(nearMilestone.threshold - nearMilestone.current)} more in commissions`
      : `${nearMilestone.threshold - nearMilestone.current} more paying referral${nearMilestone.threshold - nearMilestone.current === 1 ? '' : 's'}`;
    message = `You're almost at "${nearMilestone.label}" — just ${remaining} to go. You've got this! 💪`;
  } else if (paidReferralsLast30d > 0) {
    message = `Nice momentum — ${paidReferralsLast30d} new paying referral${paidReferralsLast30d === 1 ? '' : 's'} in the last month. Keep sharing your link and it keeps compounding.`;
  } else if (metrics.paidReferrals === 0) {
    message = `Your partner link is ready to earn. Share it with one person who'd love AgentBook this week — the first paying referral is the hardest and the most satisfying.`;
  } else {
    message = `It's been a quiet month on referrals — a single share can restart the flywheel. Your ${metrics.paidReferrals} paying referral${metrics.paidReferrals === 1 ? '' : 's'} are still earning you commission in the meantime.`;
  }

  // ── Recommendations (queued for admin approval; never applied here) ──
  const recommendations: CoachRecommendation[] = [];

  if (metrics.paidReferrals >= RAISE_REFERRAL_THRESHOLD && commissionBps < RAISE_CAP_BPS && !pendingRecTypes.has('commission_raise')) {
    const toBps = Math.min(commissionBps + RAISE_STEP_BPS, RAISE_CAP_BPS);
    if (toBps > commissionBps) {
      recommendations.push({
        type: 'commission_raise',
        payload: { fromBps: commissionBps, toBps },
        reason: `${metrics.paidReferrals} paying referrals (${money(metrics.commissionsCents)} commissions). Strong performer — consider raising ${(commissionBps / 100).toFixed(0)}% → ${(toBps / 100).toFixed(0)}%.`,
      });
    }
  }

  const bigMilestone = freshMilestones.find((k) => BIG_MILESTONES.has(k));
  if (bigMilestone && !pendingRecTypes.has('reward')) {
    recommendations.push({
      type: 'reward',
      payload: { kind: 'bonus', milestone: bigMilestone, description: 'One-time thank-you reward (e.g. a free month or bonus) for a major milestone.' },
      reason: `Just hit a major milestone (${bigMilestone.replace(/_/g, ' ')}). A reward keeps a top performer engaged.`,
    });
  }

  return { message, recommendations };
}
