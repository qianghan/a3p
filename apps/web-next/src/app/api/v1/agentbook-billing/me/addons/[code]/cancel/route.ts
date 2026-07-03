import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { code } = await params;

  const addOn = await prisma.billAddOn.findUnique({ where: { code } });
  if (!addOn) return NextResponse.json({ error: 'unknown add-on' }, { status: 404 });

  const sub = await prisma.billAddOnSubscription.findUnique({
    where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
  });
  if (!sub?.stripeSubscriptionId) {
    return NextResponse.json({ error: 'no active subscription' }, { status: 404 });
  }
  await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  return NextResponse.json({ ok: true });
}
