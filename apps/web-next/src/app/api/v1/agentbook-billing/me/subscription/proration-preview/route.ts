import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const planId = request.nextUrl.searchParams.get('planId');
  if (!planId) {
    return NextResponse.json({ error: 'planId required' }, { status: 400 });
  }

  const plan = await prisma.billPlan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) {
    return NextResponse.json({ error: 'plan not found or no Stripe price' }, { status: 404 });
  }

  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });

  // Free tier or no active Stripe sub — return trial info only
  if (!sub?.stripeSubscriptionId || sub.status === 'free') {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 90);
    return NextResponse.json({
      proratedAmountCents: 0,
      immediateChargeDate: null,
      trialEndDate: trialEnd.toISOString(),
      renewalDate: null,
    });
  }

  try {
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const currentItem = stripeSub.items.data[0];
    if (!currentItem) {
      return NextResponse.json({ error: 'no subscription items' }, { status: 400 });
    }

    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: sub.stripeCustomerId!,
      subscription: sub.stripeSubscriptionId,
      subscription_items: [{ id: currentItem.id, price: plan.stripePriceId }],
    });

    return NextResponse.json({
      proratedAmountCents: upcoming.amount_due,
      immediateChargeDate: upcoming.next_payment_attempt
        ? new Date(upcoming.next_payment_attempt * 1000).toISOString()
        : null,
      trialEndDate: null,
      renewalDate: sub.currentPeriodEnd?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('[billing] proration preview failed:', err);
    return NextResponse.json({ error: 'could not retrieve proration preview' }, { status: 502 });
  }
}
