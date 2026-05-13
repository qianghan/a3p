import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAuthorized(request: NextRequest): boolean {
  const cron = request.headers.get('x-vercel-cron');
  const secret = request.nextUrl.searchParams.get('secret');
  return cron === '1' || (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

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
