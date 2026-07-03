import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { resolveAddOnPrice, invalidateAccount } from '@naap/billing';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

const Body = z.object({
  region: z.enum(['us', 'ca', 'uk']),
  paymentMethodId: z.string(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { code } = await params;

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const { region, paymentMethodId } = parsed.data;

  const price = await resolveAddOnPrice(code, region);
  if (!price?.stripePriceId) {
    return NextResponse.json({ error: 'add-on has no Stripe price configured for this region yet' }, { status: 400 });
  }

  const billSub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  const customerId = billSub?.stripeCustomerId;
  if (!customerId) {
    return NextResponse.json({ error: 'no customer; call /me/subscription/intent first' }, { status: 400 });
  }

  try {
    const stripeSub = await getStripe().subscriptions.create({
      customer: customerId,
      items: [{ price: price.stripePriceId }],
      default_payment_method: paymentMethodId,
      metadata: { tenantId, addOnCode: code, priceId: price.id, source: 'agentbook-billing-addon' },
    });
    const addOn = await prisma.billAddOn.findUnique({ where: { code } });
    await prisma.billAddOnSubscription.upsert({
      where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn!.id } },
      create: {
        accountId: tenantId, addOnId: addOn!.id, priceId: price.id,
        status: stripeSub.status, stripeCustomerId: customerId, stripeSubscriptionId: stripeSub.id,
      },
      update: {
        priceId: price.id, status: stripeSub.status, stripeSubscriptionId: stripeSub.id, canceledAt: null,
      },
    });
    invalidateAccount(tenantId);
    return NextResponse.json({ ok: true, subscriptionId: stripeSub.id, tier: price.tier });
  } catch (err) {
    console.error('[billing] addon subscribe failed:', err);
    return NextResponse.json({ error: 'subscribe failed' }, { status: 502 });
  }
}
