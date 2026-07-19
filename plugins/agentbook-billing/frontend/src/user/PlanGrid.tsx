import { useEffect, useState } from 'react';
import { billingApi, type Plan } from '../lib/api';

const FEATURE_LABELS: Record<string, string> = {
  telegram_bot: 'Telegram bot',
  tax_package_generation: 'Tax package exports',
  multi_user_teams: 'Multi-user teams',
};

const QUOTA_LABELS: Record<string, string> = {
  expenses_created: 'Expenses/mo',
  ocr_scans: 'OCR scans/mo',
  ai_messages: 'AI messages/mo',
  invoices_sent: 'Invoices/mo',
  bank_connections: 'Bank connections',
};

function formatQuota(v: number): string {
  return v === -1 ? 'Unlimited' : String(v);
}

const CURRENCY_LOCALE: Record<string, string> = { usd: 'en-US', cad: 'en-CA', aud: 'en-AU' };

function fmtPrice(cents: number, currency: string): string {
  return (cents / 100).toLocaleString(CURRENCY_LOCALE[currency] ?? 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  });
}

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
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    billingApi.listPlans().then(setPlans).catch((e: unknown) => setLoadError(String(e)));
  }, []);

  if (loadError) return <div className="text-sm text-destructive">Failed to load plans: {loadError}</div>;
  if (!plans) return <div className="text-muted-foreground">Loading plans…</div>;

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
              {iv === 'month' ? 'Monthly' : (
                <span className="flex items-center gap-1.5">
                  Annual
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    Save up to 20%
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
                    Your plan
                  </span>
                )}
                {savings && !isCurrent && (
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    Save {savings}%
                  </span>
                )}
              </div>

              <div className="text-lg font-semibold text-foreground">{p.name}</div>
              <div className="mt-1 text-2xl font-bold text-foreground">
                {p.priceCents === 0 ? (
                  'Free'
                ) : (
                  <>
                    {fmtPrice(p.priceCents, p.currency)}
                    <span className="text-sm font-normal text-muted-foreground">
                      /{p.interval === 'year' ? 'yr' : 'mo'}
                    </span>
                  </>
                )}
              </div>
              {p.description && (
                <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
              )}

              {/* Feature checklist */}
              <ul className="mt-4 flex-1 space-y-2">
                {Object.entries(FEATURE_LABELS).map(([key, label]) => {
                  const on = p.features[key as keyof typeof p.features];
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span className={on ? 'text-primary' : 'text-muted-foreground/40'}>
                        {on ? '✓' : '—'}
                      </span>
                      <span className={on ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
                    </li>
                  );
                })}
                <li className="border-t border-border pt-2" />
                {Object.entries(QUOTA_LABELS).map(([key, label]) => {
                  const val = p.quotas[key as keyof typeof p.quotas];
                  return (
                    <li key={key} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{label}</span>
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
                {isCurrent ? 'Current plan' : p.priceCents === 0 ? 'Downgrade to Free' : 'Upgrade'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
