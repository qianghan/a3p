import { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { meApi, type Plan } from '../lib/api';

declare global {
  interface Window { STRIPE_PUBLISHABLE_KEY?: string; }
}

let _stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise(): Promise<Stripe | null> {
  if (!_stripePromise) {
    _stripePromise = loadStripe(window.STRIPE_PUBLISHABLE_KEY ?? '');
  }
  return _stripePromise;
}

function trialEndLabel(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function PayForm({ plan, onDone }: { plan: Plan; onDone: () => void }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setErr(null);
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });
    if (error) { setErr(error.message ?? 'Payment failed'); setBusy(false); return; }
    const pmId =
      typeof setupIntent?.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
    if (!pmId) { setErr('No payment method returned by Stripe'); setBusy(false); return; }
    try {
      await meApi.subscribe(plan.id, pmId);
      onDone();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {plan.priceCents > 0 && (
        <div className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="font-semibold">90-day free trial</span> — no charge until{' '}
          <strong>{trialEndLabel()}</strong>, then $
          {(plan.priceCents / 100).toFixed(2)}/
          {plan.interval === 'year' ? 'yr' : 'mo'}.
        </div>
      )}
      <PaymentElement />
      {err && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</div>}
      <button
        type="submit"
        disabled={!stripe || busy}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Processing…' : `Start trial — ${plan.name}`}
      </button>
    </form>
  );
}

export function SubscribeModal({
  plan, onClose, onDone,
}: {
  plan: Plan; onClose: () => void; onDone: () => void;
}): JSX.Element {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    meApi.intent()
      .then((r) => { setClientSecret(r.clientSecret); setStep(2); })
      .catch((e: unknown) => setErr(String(e)));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[480px] rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Subscribe to {plan.name}</h3>
          <button onClick={onClose} aria-label="close" className="text-xl text-gray-400 hover:text-gray-600">×</button>
        </div>

        {/* Step indicator */}
        <div className="mb-5 flex items-center gap-2 text-xs">
          <span className={`font-medium ${step >= 1 ? 'text-blue-600' : 'text-gray-400'}`}>
            1. Plan selected
          </span>
          <span className="text-gray-300">→</span>
          <span className={`font-medium ${step >= 2 ? 'text-blue-600' : 'text-gray-400'}`}>
            2. Payment details
          </span>
        </div>

        {err && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}

        {!clientSecret && !err && (
          <div className="py-6 text-center text-sm text-gray-500">Preparing checkout…</div>
        )}

        {clientSecret && (
          <Elements stripe={getStripePromise()} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
            <PayForm plan={plan} onDone={onDone} />
          </Elements>
        )}
      </div>
    </div>
  );
}
