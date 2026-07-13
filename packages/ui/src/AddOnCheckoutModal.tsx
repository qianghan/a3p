import React, { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Modal } from './Modal';

declare global {
  interface Window { STRIPE_PUBLISHABLE_KEY?: string; }
}

let _stripePromise: Promise<Stripe | null> | null = null;
let _cachedKey: string | undefined;
function getStripePromise(): Promise<Stripe | null> {
  const key = window.STRIPE_PUBLISHABLE_KEY ?? '';
  if (!_stripePromise || _cachedKey !== key) {
    _cachedKey = key;
    _stripePromise = loadStripe(key);
  }
  return _stripePromise;
}

export interface AddOnCheckoutModalProps {
  /** Add-on display name, shown as the modal title */
  title: string;
  /** e.g. "$99/year — Founding Member", shown under the title */
  priceLabel?: string;
  onClose: () => void;
  /** Fetches a SetupIntent client secret for the current tenant */
  fetchClientSecret: () => Promise<{ clientSecret: string }>;
  /** Called with the confirmed Stripe payment method id; should call the add-on's own subscribe route */
  onConfirmed: (paymentMethodId: string) => Promise<void>;
  /** Called after onConfirmed resolves successfully */
  onDone: () => void;
}

function PayForm({
  onConfirmed, onDone,
}: Pick<AddOnCheckoutModalProps, 'onConfirmed' | 'onDone'>): React.JSX.Element {
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
      await onConfirmed(pmId);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement />
      {err && (
        <div className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive">
          {err}
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || busy}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {busy ? 'Processing…' : 'Subscribe'}
      </button>
    </form>
  );
}

export function AddOnCheckoutModal({
  title, priceLabel, onClose, fetchClientSecret, onConfirmed, onDone,
}: AddOnCheckoutModalProps): React.JSX.Element {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchClientSecret()
      .then((r) => setClientSecret(r.clientSecret))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [fetchClientSecret]);

  return (
    <Modal isOpen onClose={onClose} title={title} description={priceLabel} size="sm">
      {err && (
        <div className="mb-4 rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {err}
        </div>
      )}
      {!clientSecret && !err && (
        <div className="py-6 text-center text-sm text-muted-foreground">Preparing checkout…</div>
      )}
      {clientSecret && (
        <Elements stripe={getStripePromise()} options={{ clientSecret, appearance: { theme: 'night' } }}>
          <PayForm onConfirmed={onConfirmed} onDone={onDone} />
        </Elements>
      )}
    </Modal>
  );
}
