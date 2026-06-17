// plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx
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

  if (loadError) return <div className="text-red-600 text-sm">Failed to load plans: {loadError}</div>;
  if (!plans) return <div className="text-gray-500">Loading plans…</div>;

  const visible = plans.filter((p) => p.priceCents === 0 || p.interval === billingInterval);

  const monthlyByCode = new Map(
    plans.filter((p) => p.interval === 'month' && p.priceCents > 0).map((p) => [p.code, p]),
  );

  return (
    <div>
      {/* Interval toggle */}
      <div className="mb-6 flex justify-center">
        <div className="inline-flex rounded-full border bg-gray-50 p-1">
          {(['month', 'year'] as const).map((iv) => (
            <button
              key={iv}
              onClick={() => setBillingInterval(iv)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                billingInterval === iv ? 'bg-white shadow text-gray-900' : 'text-gray-500'
              }`}
            >
              {iv === 'month' ? 'Monthly' : (
                <span className="flex items-center gap-1.5">
                  Annual
                  <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
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
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="mb-2 flex items-center gap-2">
                {isCurrent && (
                  <span className="rounded-full bg-blue-600 px-2.5 py-0.5 text-xs font-medium text-white">
                    Your plan
                  </span>
                )}
                {savings && !isCurrent && (
                  <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                    Save {savings}%
                  </span>
                )}
              </div>

              <div className="text-lg font-semibold text-gray-900">{p.name}</div>
              <div className="mt-1 text-2xl font-bold text-gray-900">
                {p.priceCents === 0 ? (
                  'Free'
                ) : (
                  <>
                    ${(p.priceCents / 100).toFixed(0)}
                    <span className="text-sm font-normal text-gray-500">
                      /{p.interval === 'year' ? 'yr' : 'mo'}
                    </span>
                  </>
                )}
              </div>
              {p.description && (
                <p className="mt-2 text-sm text-gray-600">{p.description}</p>
              )}

              {/* Feature checklist */}
              <ul className="mt-4 flex-1 space-y-2">
                {Object.entries(FEATURE_LABELS).map(([key, label]) => {
                  const on = p.features[key as keyof typeof p.features];
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span className={on ? 'text-green-500' : 'text-gray-300'}>
                        {on ? '✓' : '—'}
                      </span>
                      <span className={on ? 'text-gray-800' : 'text-gray-400'}>{label}</span>
                    </li>
                  );
                })}
                <li className="border-t pt-2" />
                {Object.entries(QUOTA_LABELS).map(([key, label]) => {
                  const val = p.quotas[key as keyof typeof p.quotas];
                  return (
                    <li key={key} className="flex items-center justify-between text-sm">
                      <span className="text-gray-600">{label}</span>
                      <span className="font-medium text-gray-900">{formatQuota(val)}</span>
                    </li>
                  );
                })}
              </ul>

              <button
                disabled={isCurrent}
                onClick={() => onSubscribe(p)}
                className={`mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'cursor-default bg-gray-100 text-gray-400'
                    : p.priceCents === 0
                    ? 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
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
