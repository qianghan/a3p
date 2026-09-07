import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';
import { requireCronSecret } from '@/lib/cron-auth';

// Auth: the shared fail-closed helper. This route used to authorise on
// `x-vercel-cron: 1` ALONE — an ordinary inbound header any caller can send —
// with the secret as a mere alternative. Since vercel.json's cron config
// carries no `?secret=`, that header was the only live auth path. The helper
// accepts the `Authorization: Bearer` Vercel attaches to a cron invocation.


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


async function handle(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const stale = await prisma.billSubscription.findMany({
    where: { currentPeriodEnd: { lt: new Date() } },
    select: {
      accountId: true,
      stripeSubscriptionId: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
  });

  let updated = 0;
  for (const sub of stale) {
    try {
      if (sub.stripeSubscriptionId) {
        const fresh = await getStripe().subscriptions.retrieve(sub.stripeSubscriptionId);
        const startSec = (fresh as unknown as { current_period_start: number }).current_period_start;
        const endSec = (fresh as unknown as { current_period_end: number }).current_period_end;
        await prisma.billSubscription.update({
          where: { accountId: sub.accountId },
          data: {
            status: fresh.status,
            currentPeriodStart: new Date(startSec * 1000),
            currentPeriodEnd: new Date(endSec * 1000),
            cancelAtPeriodEnd: fresh.cancel_at_period_end,
          },
        });
      } else {
        // Free tier — roll forward one month from previous end
        const start = sub.currentPeriodEnd ?? new Date();
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        await prisma.billSubscription.update({
          where: { accountId: sub.accountId },
          data: { currentPeriodStart: start, currentPeriodEnd: end },
        });
      }
      invalidateAccount(sub.accountId);
      updated++;
    } catch (err) {
      console.error('[billing] reset-quotas failed for', sub.accountId, err);
    }
  }
  return NextResponse.json({ ok: true, updated });
}

export const POST = handle;
export const GET = handle;
