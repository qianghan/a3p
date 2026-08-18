import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@naap/plugin-sdk';
import { meApi, type Plan, type ProratePreview } from '../lib/api';

/**
 * Render a translated sentence, wrapping the interpolated values in <strong>.
 *
 * The trial explainer reads "No charge today. Your trial ends on DATE, then
 * PRICE automatically." with DATE and PRICE emphasised. Splitting that into
 * three separate keys would be the easy way to keep the markup, and it would
 * be wrong: French reorders the clause, so the fragments could not be
 * reassembled into a grammatical sentence. Keeping ONE key preserves the
 * translator's freedom to move the placeholders, and this helper re-applies
 * the emphasis afterwards by splitting on the substituted values.
 */
function emphasise(template: string, values: Record<string, string>): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = template;
  let key = 0;
  // Walk the template placeholder by placeholder, in whatever order the
  // translation put them.
  const re = /\{(\w+)\}/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) {
      if (rest) parts.push(rest);
      break;
    }
    if (m.index > 0) parts.push(rest.slice(0, m.index));
    const value = values[m[1]];
    parts.push(
      value === undefined
        ? m[0]
        : <strong key={key++} className="text-foreground">{value}</strong>,
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return parts;
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
  const { t, formatMoney, formatDate } = useI18n();
  const [preview, setPreview] = useState<ProratePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    meApi.proratePreview(plan.id)
      .then(setPreview)
      .catch((e: unknown) => setFetchErr(String(e)))
      .finally(() => setLoading(false));
  }, [plan.id]);

  // Unlike catalog plan prices (always whole dollars), proratedAmountCents comes
  // straight from Stripe's upcoming-invoice proration and is rarely a round
  // number. formatMoney keeps both decimals, so the charge shown still matches
  // what Stripe bills — the reason the old local formatter existed.
  const money = (cents: number): string => formatMoney(cents, plan.currency.toUpperCase());
  // A Stripe renewal/trial-end is a real instant, so formatDate (local) is
  // correct here, NOT formatDateOnly.
  const day = (iso: string | null): string => (iso ? formatDate(iso, { month: 'long', day: 'numeric', year: 'numeric' }) : '—');
  const intervalShort = plan.interval === 'year' ? t('billing.per_year_short') : t('billing.per_month_short');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">{t('billing.upgrade_to', { plan: plan.name })}</h3>
          <button
            onClick={onClose}
            aria-label={t('billing.close')}
            className="text-xl text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('billing.calculating_pricing')}</div>
        )}

        {fetchErr && (
          <div className="rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {t('billing.pricing_preview_failed')}{' '}
            <button onClick={onConfirm} className="underline">{t('billing.continue_anyway')}</button>
          </div>
        )}

        {!loading && !fetchErr && preview && (
          <div className="space-y-4">
            {preview.trialEndDate ? (
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
                <p className="text-sm font-semibold text-foreground">{t('billing.trial_included')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {emphasise(t('billing.trial_explainer'), {
                    date: day(preview.trialEndDate),
                    price: `${money(plan.priceCents)}/${intervalShort}`,
                  })}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('billing.prorated_charge_today')}</span>
                  <span className="font-semibold text-foreground">
                    {money(preview.proratedAmountCents)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('billing.next_full_charge')}</span>
                  <span className="text-foreground">
                    {t('billing.next_charge_value', {
                      price: money(plan.priceCents),
                      interval: intervalShort,
                      date: day(preview.renewalDate),
                    })}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('billing.proration_explainer')}
                </p>
              </div>
            )}

            <button
              onClick={onConfirm}
              className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('billing.continue_to_payment')}
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-lg border border-border py-2.5 text-sm text-muted-foreground hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
