import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

const Body = z.object({}).optional();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; priceId: string }> },
): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  Body.parse(await request.json().catch(() => undefined));
  const { priceId } = await params;

  const price = await prisma.billAddOnPrice.findUnique({
    where: { id: priceId },
    include: { addOn: true },
  });
  if (!price) return NextResponse.json({ error: 'price not found' }, { status: 404 });

  const stripe = getStripe();
  try {
    const product = await stripe.products.create({
      name: `${price.addOn.name} (${price.tier})`,
      metadata: { addOnCode: price.addOn.code, tier: price.tier, region: price.region },
    });
    const stripePrice = await stripe.prices.create({
      product: product.id,
      unit_amount: price.priceCents,
      currency: price.currency,
      recurring: { interval: price.addOn.interval as 'year' | 'month' },
    });
    const updated = await prisma.billAddOnPrice.update({
      where: { id: priceId },
      data: { stripePriceId: stripePrice.id },
    });
    return NextResponse.json({ price: updated });
  } catch (err) {
    console.error('[billing] addon Stripe price create failed:', err);
    return NextResponse.json({ error: 'create failed' }, { status: 500 });
  }
}
