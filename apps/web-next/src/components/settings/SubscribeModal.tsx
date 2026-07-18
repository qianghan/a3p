'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { Loader2, X } from 'lucide-react';

interface PlanTarget {
  kind: 'plan';
  id: string;
  name: string;
  priceCents: number;
  interval: string;
}

interface AddonTarget {
  kind: 'addon';
  code: string;
  name: string;
  priceCents: number;
  interval: string;
  region: string;
}

type SubscribeTarget = PlanTarget | AddonTarget;

interface Props {
  target: SubscribeTarget;
  onClose: () => void;
  onSubscribed: () => void;
}

let stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise(): Promise<Stripe | null> {
  if (!stripePromise) {
    const pk = (typeof window !== 'undefined' ? (window as unknown as { STRIPE_PUBLISHABLE_KEY?: string }).STRIPE_PUBLISHABLE_KEY : '') || '';
    stripePromise = loadStripe(pk);
  }
  return stripePromise;
}

function fmtPrice(cents: number, interval: string): string {
  const dollars = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return `$${dollars}/${interval === 'year' ? 'yr' : 'mo'}`;
}

function SubscribeForm({ target, onClose, onSubscribed }: Props): React.ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });

    if (confirmError || !setupIntent?.payment_method) {
      setError(confirmError?.message || 'Could not confirm your card. Please try again.');
      setSubmitting(false);
      return;
    }

    try {
      const paymentMethodId =
        typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method.id;
      const endpoint = target.kind === 'plan'
        ? '/api/v1/agentbook-billing/me/subscription'
        : `/api/v1/agentbook-billing/me/addons/${target.code}/subscribe`;
      const body = target.kind === 'plan'
        ? { planId: target.id, paymentMethodId }
        : { region: target.region, paymentMethodId };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error || 'Subscription failed. Please try again.');
        setSubmitting(false);
        return;
      }
      onSubscribed();
    } catch {
      setError('Subscription failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || submitting}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Subscribe to {target.name} — {fmtPrice(target.priceCents, target.interval)}
        </button>
      </div>
    </form>
  );
}

export function SubscribeModal({ target, onClose, onSubscribed }: Props): React.ReactElement {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })
      .then((r) => r.json())
      .then((j) => {
        if (j.clientSecret) setClientSecret(j.clientSecret);
        else setError('Could not start checkout. Please try again.');
      })
      .catch(() => setError('Could not start checkout. Please try again.'));
  }, []);

  const options = useMemo(() => (clientSecret ? { clientSecret } : undefined), [clientSecret]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-foreground">
            Subscribe to {target.name}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        {!clientSecret && !error ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : clientSecret ? (
          <Elements stripe={getStripePromise()} options={options}>
            <SubscribeForm target={target} onClose={onClose} onSubscribed={onSubscribed} />
          </Elements>
        ) : null}
      </div>
    </div>
  );
}
