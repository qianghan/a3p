import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getCurrentPlan, invalidateAccount } from '@naap/billing';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const cur = await getCurrentPlan(tenantId);
  return NextResponse.json(cur);
}

const Body = z.object({
  planId: z.string(),
  paymentMethodId: z.string(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const { planId, paymentMethodId } = parsed.data;

  const plan = await prisma.billPlan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) {
    return NextResponse.json({ error: 'plan has no Stripe price' }, { status: 400 });
  }

  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  const customerId = sub?.stripeCustomerId;
  if (!customerId) {
    return NextResponse.json({ error: 'no customer; call /intent first' }, { status: 400 });
  }

  // 90-day free trial on first-time paid subscriptions only. If this account
  // has already had a non-free subscription before (status: trialing, active,
  // past_due, canceled, ...), skip the trial — we don't want to grant a fresh
  // 90 days every time someone re-subscribes.
  const hadPaidSubBefore =
    !!sub?.stripeSubscriptionId && sub?.status !== undefined && sub.status !== 'free';
  const TRIAL_DAYS = 90;

  try {
    const stripeSub = await getStripe().subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripePriceId }],
      default_payment_method: paymentMethodId,
      metadata: { tenantId, planCode: plan.code, source: 'agentbook-billing' },
      ...(hadPaidSubBefore ? {} : { trial_period_days: TRIAL_DAYS }),
    });
    const startSec = (stripeSub as unknown as { current_period_start: number }).current_period_start;
    const endSec = (stripeSub as unknown as { current_period_end: number }).current_period_end;
    await prisma.billSubscription.upsert({
      where: { accountId: tenantId },
      create: {
        accountId: tenantId, planId, status: stripeSub.status,
        stripeCustomerId: customerId, stripeSubscriptionId: stripeSub.id,
        currentPeriodStart: new Date(startSec * 1000),
        currentPeriodEnd: new Date(endSec * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
      update: {
        planId, status: stripeSub.status, stripeSubscriptionId: stripeSub.id,
        currentPeriodStart: new Date(startSec * 1000),
        currentPeriodEnd: new Date(endSec * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
    });
    invalidateAccount(tenantId);
    return NextResponse.json({ ok: true, subscriptionId: stripeSub.id });
  } catch (err) {
    console.error('[billing] subscribe failed:', err);
    return NextResponse.json({ error: 'subscribe failed' }, { status: 502 });
  }
}
