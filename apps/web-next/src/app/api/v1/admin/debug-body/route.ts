/**
 * Diagnostic: echo the raw request body length, SHA256, and the first
 * 200 bytes so we can verify what `request.text()` in the function
 * receives matches what the caller actually sent.
 *
 * Used to diagnose Stripe-webhook signature mismatches (where the
 * signed payload bytes need to match the verified payload bytes).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  const raw = await request.text();
  const buf = Buffer.from(raw, 'utf-8');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');

  const whsec = process.env.STRIPE_WEBHOOK_SECRET || '';
  const whsecSha = crypto.createHash('sha256').update(whsec, 'utf-8').digest('hex');
  const sig = headers['stripe-signature'] ?? '';

  // Compute the expected HMAC ourselves the way Stripe SDK does.
  let computedV1: string | null = null;
  let stripeError: string | null = null;
  let stripeOk = false;
  if (sig && whsec) {
    const m = /t=(\d+)/.exec(sig);
    if (m) {
      const ts = m[1];
      computedV1 = crypto.createHmac('sha256', whsec).update(`${ts}.${raw}`).digest('hex');
    }
    // Also let Stripe SDK try to verify with our env secret
    try {
      getStripe().webhooks.constructEvent(raw, sig, whsec);
      stripeOk = true;
    } catch (err) {
      stripeError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    contentLengthHeader: headers['content-length'],
    bytesRead: buf.length,
    stringLength: raw.length,
    sha256: sha,
    first200: raw.slice(0, 200),
    stripeSig: sig,
    whsec_length: whsec.length,
    whsec_sha256: whsecSha,
    computedV1,
    stripeOk,
    stripeError,
  });
}
