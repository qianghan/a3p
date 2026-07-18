import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const stripe = getStripe();
  const existing = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const cust = await stripe.customers.create({ metadata: { tenantId } });
    customerId = cust.id;
    const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const region = cfg?.jurisdiction || 'us';
    const freePlanId = (await prisma.billPlan.findFirst({ where: { code: 'free', region } }))?.id;
    await prisma.billSubscription.upsert({
      where: { accountId: tenantId },
      create: {
        accountId: tenantId,
        planId: freePlanId ?? '',
        status: 'active',
        stripeCustomerId: customerId,
      },
      update: { stripeCustomerId: customerId },
    });
  }
  const seti = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
  return NextResponse.json({ clientSecret: seti.client_secret, customerId });
}
