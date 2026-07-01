import 'server-only';
import Stripe from 'stripe';

/**
 * Single Stripe SDK instance per Vercel Function. Reads the key once
 * at module load. Test mode (sk_test_*) outside production; live mode
 * (sk_live_* or rk_live_*) only when VERCEL_ENV === 'production'.
 *
 * rk_live_* (a Stripe *restricted* key, scoped to a curated set of
 * permissions) is accepted alongside sk_live_* — it's a first-class Stripe
 * live-mode key type, just narrower, and is what this app is configured
 * with in production.
 *
 * Tests use _setStripeForTests() to swap the export.
 */
let _stripe: Stripe | null = null;

const isLiveKey = (key: string) => key.startsWith('sk_live_') || key.startsWith('rk_live_');
const isTestKey = (key: string) => key.startsWith('sk_test_') || key.startsWith('rk_test_');

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('[billing] STRIPE_SECRET_KEY not set');
  const isProd = process.env.VERCEL_ENV === 'production';
  // Allow a test key in production when STRIPE_SANDBOX_OK=1 — needed for
  // pre-launch sandbox testing on the production deployment. Without
  // this escape hatch the webhook handler can't even construct Stripe
  // (which means signature verification throws before it runs).
  const sandboxOk = process.env.STRIPE_SANDBOX_OK === '1';
  if (isProd && !isLiveKey(key) && !sandboxOk) {
    throw new Error('[billing] production env must use a live-mode key (sk_live_*/rk_live_*) — set STRIPE_SANDBOX_OK=1 to override for sandbox testing');
  }
  if (isProd && isTestKey(key) && sandboxOk) {
    console.warn('[billing] production env running with a test-mode key — STRIPE_SANDBOX_OK=1 acknowledged');
  }
  if (!isProd && !isTestKey(key)) {
    console.warn('[billing] non-production env should use a test-mode key (sk_test_*/rk_test_*)');
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
