import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  if (!sub?.stripeSubscriptionId) {
    return NextResponse.json({ error: 'no subscription' }, { status: 404 });
  }
  await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  await prisma.billSubscription.update({
    where: { accountId: tenantId },
    data: { cancelAtPeriodEnd: false, canceledAt: null },
  });
  invalidateAccount(tenantId);
  return NextResponse.json({ ok: true });
}
