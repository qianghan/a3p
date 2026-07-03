import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/billing/stripe';
import { prisma } from '@naap/database';
import { applyEvent } from './handlers';
import type Stripe from 'stripe';

// Stripe webhooks must run on Node runtime (raw body + signature verify)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 });

  const rawBody = await request.text();
  // Two separate Stripe webhook endpoints deliver here: the platform one
  // (STRIPE_WEBHOOK_SECRET) and a Connect one scoped to connected-account
  // events like account.updated (STRIPE_CONNECT_WEBHOOK_SECRET) — each has
  // its own signing secret, so we try both rather than knowing in advance
  // which endpoint sent a given request.
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (s): s is string => !!s,
  );
  if (secrets.length === 0) return NextResponse.json({ error: 'webhook secret not configured' }, { status: 500 });

  let event: Stripe.Event | undefined;
  for (const secret of secrets) {
    try {
      event = getStripe().webhooks.constructEvent(rawBody, sig, secret);
      break;
    } catch {
      // try the next configured secret
    }
  }
  if (!event) {
    console.warn('[stripe-webhook] signature verification failed for all configured secrets');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  // Idempotency: try to insert BillEvent. If P2002 (unique violation),
  // we've already processed this event — short-circuit success.
  try {
    await prisma.billEvent.create({
      data: {
        accountId: (event.data.object as { metadata?: { tenantId?: string } })?.metadata?.tenantId ?? null,
        stripeEventId: event.id,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify(event)),
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      return NextResponse.json({ received: true, idempotent: true });
    }
    console.error('[stripe-webhook] BillEvent create failed:', err);
    return NextResponse.json({ error: 'persist failed' }, { status: 500 });
  }

  try {
    await applyEvent(event);
    await prisma.billEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() },
    });
  } catch (err) {
    console.error('[stripe-webhook] applyEvent failed:', err);
    // Return 500 so Stripe retries. BillEvent row stays without processedAt.
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
