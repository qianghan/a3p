import { useEffect, useState } from 'react';
import { useI18n } from '@naap/plugin-sdk';
import { billingApi, type Plan } from '../lib/api';

// Maps hold translation KEYS, not English text — the API's feature/quota ids
// stay separate from their display strings so the latter can be translated.
const FEATURE_LABEL_KEYS: Record<string, string> = {
  telegram_bot: 'billing.feature_telegram_bot',
  tax_package_generation: 'billing.feature_tax_package',
  multi_user_teams: 'billing.feature_multi_user',
};

const QUOTA_LABEL_KEYS: Record<string, string> = {
  expenses_created: 'billing.quota_expenses_mo',
  ocr_scans: 'billing.quota_ocr_mo',
  ai_messages: 'billing.quota_ai_messages_mo',
  invoices_sent: 'billing.quota_invoices_mo',
  bank_connections: 'billing.quota_bank_connections',
};

// The local CURRENCY_LOCALE table is gone — it was one of four identical
// copies in this plugin, and formatMoney already carries the same mapping.

function savingsPct(monthlyPlan: Plan, annualPlan: Plan): number {
  if (monthlyPlan.priceCents === 0) return 0;
  const monthlyYearly = monthlyPlan.priceCents * 12;
  return Math.round(((monthlyYearly - annualPlan.priceCents) / monthlyYearly) * 100);
}

export function PlanGrid({
  currentPlanCode,
  onSubscribe,
}: {
  currentPlanCode: string;
  onSubscribe: (p: Plan) => void;
}): JSX.Element {
  const { t, formatMoney } = useI18n();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    billingApi.listPlans().then(setPlans).catch((e: unknown) => setLoadError(String(e)));
  }, []);

  if (loadError) return <div className="text-sm text-destructive">{t('billing.plans_load_failed', { error: loadError })}</div>;
  if (!plans) return <div className="text-muted-foreground">{t('billing.loading_plans')}</div>;

  const formatQuota = (v: number): string => (v === -1 ? t('billing.unlimited') : String(v));

  const visible = plans.filter((p) => p.priceCents === 0 || p.interval === billingInterval);

  const monthlyByCode = new Map(
    plans.filter((p) => p.interval === 'month' && p.priceCents > 0).map((p) => [p.code, p]),
  );

  return (
    <div>
      {/* Interval toggle */}
      <div className="mb-6 flex justify-center">
        <div className="inline-flex rounded-full border border-border bg-muted p-1">
          {(['month', 'year'] as const).map((iv) => (
            <button
              key={iv}
              onClick={() => setBillingInterval(iv)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                billingInterval === iv
                  ? 'bg-card text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {iv === 'month' ? t('billing.monthly') : (
                <span className="flex items-center gap-1.5">
                  {t('billing.annual')}
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    {t('billing.save_up_to')}
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {visible.map((p) => {
          const isCurrent = p.code === currentPlanCode;
          const baseCode = p.code.replace('-yearly', '');
          const monthlyVariant = monthlyByCode.get(baseCode);
          const savings = p.interval === 'year' && monthlyVariant
            ? savingsPct(monthlyVariant, p) : null;

          return (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border p-6 ${
                isCurrent
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                  : 'border-border bg-card hover:border-primary/30 transition-colors'
              }`}
            >
              <div className="mb-2 flex items-center gap-2 min-h-[24px]">
                {isCurrent && (
                  <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
                    {t('billing.your_plan')}
                  </span>
                )}
                {savings && !isCurrent && (
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {t('billing.save_pct', { pct: savings })}
                  </span>
                )}
              </div>

              <div className="text-lg font-semibold text-foreground">{p.name}</div>
              <div className="mt-1 text-2xl font-bold text-foreground">
                {p.priceCents === 0 ? (
                  t('billing.free')
                ) : (
                  <>
                    {formatMoney(p.priceCents, p.currency.toUpperCase())}
                    <span className="text-sm font-normal text-muted-foreground">
                      /{p.interval === 'year' ? t('billing.per_year_short') : t('billing.per_month_short')}
                    </span>
                  </>
                )}
              </div>
              {p.description && (
                <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
              )}

              {/* Feature checklist */}
              <ul className="mt-4 flex-1 space-y-2">
                {Object.entries(FEATURE_LABEL_KEYS).map(([key, labelKey]) => {
                  const on = p.features[key as keyof typeof p.features];
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span className={on ? 'text-primary' : 'text-muted-foreground/40'}>
                        {on ? '✓' : '—'}
                      </span>
                      <span className={on ? 'text-foreground' : 'text-muted-foreground'}>{t(labelKey)}</span>
                    </li>
                  );
                })}
                <li className="border-t border-border pt-2" />
                {Object.entries(QUOTA_LABEL_KEYS).map(([key, labelKey]) => {
                  const val = p.quotas[key as keyof typeof p.quotas];
                  return (
                    <li key={key} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{t(labelKey)}</span>
                      <span className={`font-medium ${val === -1 ? 'text-primary' : 'text-foreground'}`}>
                        {formatQuota(val)}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <button
                disabled={isCurrent}
                onClick={() => onSubscribe(p)}
                className={`mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'cursor-default bg-muted text-muted-foreground'
                    : p.priceCents === 0
                    ? 'border border-border text-foreground hover:bg-muted'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {isCurrent ? t('billing.current_plan') : p.priceCents === 0 ? t('billing.downgrade_to_free') : t('billing.upgrade')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
