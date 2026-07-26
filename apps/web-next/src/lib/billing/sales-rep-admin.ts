import 'server-only';
import { prisma } from '@/lib/db';
import { invalidateAccount } from '@naap/billing';

/**
 * Edit an existing rep's commission rate / payout cadence — without touching
 * their plan. (The direct-invite POST comps a plan and 409s for reps on a real
 * Stripe subscription, so it can't be used to edit an approved applicant's
 * rate.) Rate changes apply going forward only; already-accrued commission
 * keeps the rate locked in at accrual time.
 */

const FREQUENCIES = new Set(['monthly', 'quarterly', 'annual']);

export class RepAdminError extends Error {}

export async function updateRepCommission(
  tenantId: string,
  input: { commissionBps?: number; payoutFrequency?: string },
): Promise<{ tenantId: string; commissionBps: number; payoutFrequency: string }> {
  const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId } });
  if (!profile) throw new RepAdminError('This user is not a sales rep.');
  if (profile.status !== 'active') throw new RepAdminError(`Rep is '${profile.status}' — reactivate before editing.`);

  const data: { commissionBps?: number; payoutFrequency?: string } = {};

  if (input.commissionBps != null) {
    const bps = Number(input.commissionBps);
    if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) {
      throw new RepAdminError('commissionBps must be an integer 1–10000 (e.g. 2000 = 20%).');
    }
    data.commissionBps = bps;
  }
  if (input.payoutFrequency != null) {
    if (!FREQUENCIES.has(input.payoutFrequency)) {
      throw new RepAdminError("payoutFrequency must be 'monthly', 'quarterly', or 'annual'.");
    }
    data.payoutFrequency = input.payoutFrequency;
  }
  if (Object.keys(data).length === 0) throw new RepAdminError('Nothing to update.');

  const updated = await prisma.salesRepProfile.update({ where: { tenantId }, data });
  invalidateAccount(tenantId);
  return { tenantId, commissionBps: updated.commissionBps, payoutFrequency: updated.payoutFrequency };
}
