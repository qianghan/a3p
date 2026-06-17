import { useEffect, useState } from 'react';
import { meApi, type Plan, type ProratePreview } from '../lib/api';

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Upgrade to {plan.name}</h3>
          <button onClick={onClose} aria-label="close" className="text-xl text-gray-400 hover:text-gray-600">×</button>
        </div>

        {loading && (
          <div className="py-8 text-center text-sm text-gray-500">Calculating pricing…</div>
        )}

        {fetchErr && (
          <div className="rounded bg-red-50 p-3 text-sm text-red-700">
            Could not load pricing preview. <button onClick={onConfirm} className="underline">Continue anyway</button>
          </div>
        )}

        {!loading && !fetchErr && preview && (
          <div className="space-y-4">
            {preview.trialEndDate ? (
              /* Free → Paid: 90-day trial */
              <div className="rounded-lg bg-blue-50 p-4">
                <p className="text-sm font-semibold text-blue-900">90-day free trial included</p>
                <p className="mt-1 text-sm text-blue-700">
                  No charge today. Your trial ends on{' '}
                  <strong>{fmtDate(preview.trialEndDate)}</strong>, then{' '}
                  <strong>
                    ${(plan.priceCents / 100).toFixed(2)}/{plan.interval === 'year' ? 'yr' : 'mo'}
                  </strong>{' '}
                  automatically.
                </p>
              </div>
            ) : (
              /* Paid → Paid: proration */
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Prorated charge today</span>
                  <span className="font-semibold text-gray-900">
                    {fmtCents(preview.proratedAmountCents)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Next full charge</span>
                  <span className="text-gray-900">
                    {fmtCents(plan.priceCents)}/{plan.interval === 'year' ? 'yr' : 'mo'}{' '}
                    on {fmtDate(preview.renewalDate)}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  Credit for your unused monthly period is applied to today's charge.
                </p>
              </div>
            )}

            <button
              onClick={onConfirm}
              className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Continue to payment →
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-lg border py-2.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
