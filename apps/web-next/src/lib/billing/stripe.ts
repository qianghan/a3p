import 'server-only';
import Stripe from 'stripe';

/**
 * Single Stripe SDK instance per Vercel Function. Reads the key once
 * at module load. Test mode (sk_test_*) outside production; live mode
 * (sk_live_*) only when VERCEL_ENV === 'production'.
 *
 * Tests use _setStripeForTests() to swap the export.
 */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('[billing] STRIPE_SECRET_KEY not set');
  const isProd = process.env.VERCEL_ENV === 'production';
  // Allow sk_test_* in production when STRIPE_SANDBOX_OK=1 — needed for
  // pre-launch sandbox testing on the production deployment. Without
  // this escape hatch the webhook handler can't even construct Stripe
  // (which means signature verification throws before it runs).
  const sandboxOk = process.env.STRIPE_SANDBOX_OK === '1';
  if (isProd && !key.startsWith('sk_live_') && !sandboxOk) {
    throw new Error('[billing] production env must use sk_live_* key (set STRIPE_SANDBOX_OK=1 to override for sandbox testing)');
  }
  if (isProd && key.startsWith('sk_test_') && sandboxOk) {
    console.warn('[billing] production env running with sk_test_* — STRIPE_SANDBOX_OK=1 acknowledged');
  }
  if (!isProd && !key.startsWith('sk_test_')) {
    console.warn('[billing] non-production env should use sk_test_* key');
  }
  _stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion });
  return _stripe;
}

export function _resetStripeForTests(): void {
  _stripe = null;
}

export function _setStripeForTests(s: Stripe): void {
  _stripe = s;
}
