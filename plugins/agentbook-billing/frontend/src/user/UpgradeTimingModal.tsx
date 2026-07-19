import { useEffect, useState } from 'react';
import { meApi, type Plan, type ProratePreview } from '../lib/api';

const CURRENCY_LOCALE: Record<string, string> = { usd: 'en-US', cad: 'en-CA', aud: 'en-AU' };

function fmtCents(cents: number, currency: string): string {
  // Unlike catalog plan prices (always whole dollars), preview.proratedAmountCents
  // comes straight from Stripe's upcoming-invoice proration and is rarely a round
  // number — keep both decimal places so the charge shown matches what Stripe bills.
  return (cents / 100).toLocaleString(CURRENCY_LOCALE[currency] ?? 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

export function UpgradeTimingModal({
  plan,
  onConfirm,
  onClose,
}: {
  plan: Plan;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<ProratePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    meApi.proratePreview(plan.id)
      .then(setPreview)
      .catch((e: unknown) => setFetchErr(String(e)))
      .finally(() => setLoading(false));
  }, [plan.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Upgrade to {plan.name}</h3>
          <button
            onClick={onClose}
            aria-label="close"
            className="text-xl text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="py-8 text-center text-sm text-muted-foreground">Calculating pricing…</div>
        )}

        {fetchErr && (
          <div className="rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load pricing preview.{' '}
            <button onClick={onConfirm} className="underline">Continue anyway</button>
          </div>
        )}

        {!loading && !fetchErr && preview && (
          <div className="space-y-4">
            {preview.trialEndDate ? (
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
                <p className="text-sm font-semibold text-foreground">90-day free trial included</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  No charge today. Your trial ends on{' '}
                  <strong className="text-foreground">{fmtDate(preview.trialEndDate)}</strong>, then{' '}
                  <strong className="text-foreground">
                    {fmtCents(plan.priceCents, plan.currency)}/{plan.interval === 'year' ? 'yr' : 'mo'}
                  </strong>{' '}
                  automatically.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Prorated charge today</span>
                  <span className="font-semibold text-foreground">
                    {fmtCents(preview.proratedAmountCents, plan.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Next full charge</span>
                  <span className="text-foreground">
                    {fmtCents(plan.priceCents, plan.currency)}/{plan.interval === 'year' ? 'yr' : 'mo'}{' '}
                    on {fmtDate(preview.renewalDate)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Credit for your unused monthly period is applied to today's charge.
                </p>
              </div>
            )}

            <button
              onClick={onConfirm}
              className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Continue to payment →
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-lg border border-border py-2.5 text-sm text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
