# Billing UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add monthly/annual interval toggle with savings badges, rich feature-list plan cards with current-plan highlighting, a proration preview API, and an upgrade timing modal + polished Stripe credit card flow.

**Architecture:** All frontend changes are in `plugins/agentbook-billing/frontend/src/user/`. One new Next.js API route for proration preview. No schema changes. No new plugins. The existing `SubscribeModal` / `PlanGrid` / `UserApp` are replaced in-place.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Stripe.js (`@stripe/react-stripe-js`), Next.js App Router, Prisma, `@naap/billing`, `safeResolveAgentbookTenant`.

---

## File Map

| Action | File | Purpose |
|---|---|---|
| Modify | `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx` | Add interval toggle + rich feature cards |
| Modify | `plugins/agentbook-billing/frontend/src/lib/api.ts` | Add `ProratePreview` type + `meApi.proratePreview()` |
| Modify | `plugins/agentbook-billing/frontend/src/user/UserApp.tsx` | Wire timing modal + typed modal state |
| Modify | `plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx` | Step indicator + trial callout |
| Create | `plugins/agentbook-billing/frontend/src/user/UpgradeTimingModal.tsx` | Proration preview + timing choice |
| Create | `apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/proration-preview/route.ts` | Stripe upcoming invoice preview |

---

### Task 1: Rich Plan Cards + Monthly/Annual Toggle

**Files:**
- Modify: `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx`

- [ ] **Step 1: Replace PlanGrid.tsx entirely**

```tsx
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
  const [interval, setInterval] = useState<'month' | 'year'>('month');

  useEffect(() => { billingApi.listPlans().then(setPlans); }, []);

  if (!plans) return <div className="text-gray-500">Loading plans…</div>;

  const visible = plans.filter((p) => p.priceCents === 0 || p.interval === interval);

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
              onClick={() => setInterval(iv)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                interval === iv ? 'bg-white shadow text-gray-900' : 'text-gray-500'
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
```

- [ ] **Step 2: Build the billing plugin to verify no TypeScript errors**

```bash
cd plugins/agentbook-billing/frontend && npm run build 2>&1 | tail -20
```

Expected: build completes, `dist/production/agentbook-billing.js` updated, zero TS errors in PlanGrid.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx
git commit -m "feat(billing): rich plan cards + monthly/annual interval toggle"
```

---

### Task 2: Proration Preview API Route

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/proration-preview/route.ts`
- Modify: `plugins/agentbook-billing/frontend/src/lib/api.ts`

- [ ] **Step 1: Create the proration preview route**

```typescript
// apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/proration-preview/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const planId = request.nextUrl.searchParams.get('planId');
  if (!planId) {
    return NextResponse.json({ error: 'planId required' }, { status: 400 });
  }

  const plan = await prisma.billPlan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) {
    return NextResponse.json({ error: 'plan not found or no Stripe price' }, { status: 404 });
  }

  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });

  // Free tier or no active Stripe sub — return trial info only
  if (!sub?.stripeSubscriptionId || sub.status === 'free') {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 90);
    return NextResponse.json({
      proratedAmountCents: 0,
      immediateChargeDate: null,
      trialEndDate: trialEnd.toISOString(),
      renewalDate: null,
    });
  }

  try {
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const currentItem = stripeSub.items.data[0];
    if (!currentItem) {
      return NextResponse.json({ error: 'no subscription items' }, { status: 400 });
    }

    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: sub.stripeCustomerId!,
      subscription: sub.stripeSubscriptionId,
      subscription_items: [{ id: currentItem.id, price: plan.stripePriceId }],
    });

    return NextResponse.json({
      proratedAmountCents: upcoming.amount_due,
      immediateChargeDate: upcoming.next_payment_attempt
        ? new Date(upcoming.next_payment_attempt * 1000).toISOString()
        : null,
      trialEndDate: null,
      renewalDate: sub.currentPeriodEnd?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('[billing] proration preview failed:', err);
    return NextResponse.json({ error: 'could not retrieve proration preview' }, { status: 502 });
  }
}
```

- [ ] **Step 2: Add `ProratePreview` type and `meApi.proratePreview()` to api.ts**

In `plugins/agentbook-billing/frontend/src/lib/api.ts`, add after the `CurrentPlanView` interface (line 46) and at the end of `meApi`:

```typescript
// Add this interface after CurrentPlanView:
export interface ProratePreview {
  proratedAmountCents: number;
  immediateChargeDate: string | null;
  trialEndDate: string | null;
  renewalDate: string | null;
}

// Add this method to the meApi object (after reactivate):
proratePreview: async (planId: string): Promise<ProratePreview> =>
  json<ProratePreview>(
    await fetch(`/api/v1/agentbook-billing/me/subscription/proration-preview?planId=${encodeURIComponent(planId)}`),
  ),
```

Full updated `meApi` export in `lib/api.ts`:

```typescript
export const meApi = {
  current: async (): Promise<CurrentPlanView> =>
    json<CurrentPlanView>(await fetch('/api/v1/agentbook-billing/me/subscription')),
  intent: async (): Promise<{ clientSecret: string; customerId: string }> =>
    json(await fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })),
  subscribe: async (planId: string, paymentMethodId: string): Promise<void> => {
    await json<unknown>(await fetch('/api/v1/agentbook-billing/me/subscription', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, paymentMethodId }),
    }));
  },
  cancel: async (): Promise<void> => {
    await json<unknown>(await fetch('/api/v1/agentbook-billing/me/subscription/cancel', { method: 'POST' }));
  },
  reactivate: async (): Promise<void> => {
    await json<unknown>(await fetch('/api/v1/agentbook-billing/me/subscription/reactivate', { method: 'POST' }));
  },
  proratePreview: async (planId: string): Promise<ProratePreview> =>
    json<ProratePreview>(
      await fetch(`/api/v1/agentbook-billing/me/subscription/proration-preview?planId=${encodeURIComponent(planId)}`),
    ),
};
```

- [ ] **Step 3: Verify TypeScript compiles in web-next**

```bash
cd apps/web-next && npx tsc --noEmit 2>&1 | grep "proration" | head -10
```

Expected: no errors mentioning the new route file.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/proration-preview/route.ts \
        plugins/agentbook-billing/frontend/src/lib/api.ts
git commit -m "feat(billing): proration preview API + client type"
```

---

### Task 3: UpgradeTimingModal + SubscribeModal Polish + UserApp Wiring

**Files:**
- Create: `plugins/agentbook-billing/frontend/src/user/UpgradeTimingModal.tsx`
- Modify: `plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx`
- Modify: `plugins/agentbook-billing/frontend/src/user/UserApp.tsx`

- [ ] **Step 1: Create UpgradeTimingModal.tsx**

```tsx
// plugins/agentbook-billing/frontend/src/user/UpgradeTimingModal.tsx
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
          <button onClick={onClose} className="text-xl text-gray-400 hover:text-gray-600">×</button>
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
```

- [ ] **Step 2: Replace SubscribeModal.tsx with step-indicator + trial callout version**

```tsx
// plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx
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
```

- [ ] **Step 3: Replace UserApp.tsx to wire timing modal**

```tsx
// plugins/agentbook-billing/frontend/src/user/UserApp.tsx
import { useEffect, useState } from 'react';
import { CurrentPlanCard } from './CurrentPlanCard';
import { UsageBars } from './UsageBars';
import { PlanGrid } from './PlanGrid';
import { SubscribeModal } from './SubscribeModal';
import { UpgradeTimingModal } from './UpgradeTimingModal';
import { meApi, type CurrentPlanView, type Plan } from '../lib/api';

type ModalState =
  | { kind: 'none' }
  | { kind: 'timing'; plan: Plan }
  | { kind: 'subscribe'; plan: Plan };

export function UserApp(): JSX.Element {
  const [view, setView] = useState<CurrentPlanView | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    meApi.current().then(setView).catch((e: unknown) => console.error(e));
  }, [refresh]);

  if (!view) return <div className="p-6 text-gray-500">Loading…</div>;

  const hasActivePaidSub =
    view.plan.priceCents > 0 &&
    (view.status === 'active' || view.status === 'trialing');

  const handleSubscribe = (p: Plan): void => {
    // Downgrade to free: cancel at period end
    if (p.priceCents === 0) {
      if (window.confirm('Downgrade to the Free plan at the end of your current period?')) {
        meApi.cancel().then(() => setRefresh((r) => r + 1)).catch(console.error);
      }
      return;
    }
    // Monthly → Annual upgrade: show proration timing modal
    if (hasActivePaidSub && p.interval === 'year') {
      setModal({ kind: 'timing', plan: p });
      return;
    }
    // All other upgrades: go straight to Stripe checkout
    setModal({ kind: 'subscribe', plan: p });
  };

  const handleDone = (): void => {
    setModal({ kind: 'none' });
    setRefresh((r) => r + 1);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <CurrentPlanCard view={view} onRefresh={() => setRefresh((r) => r + 1)} />
      <div className="rounded-lg border bg-white p-6">
        <h3 className="mb-3 text-sm font-medium text-gray-600">Usage this period</h3>
        <UsageBars usage={view.usage} />
      </div>
      <h3 className="text-lg font-semibold">Available plans</h3>
      <PlanGrid currentPlanCode={view.plan.code} onSubscribe={handleSubscribe} />

      {modal.kind === 'timing' && (
        <UpgradeTimingModal
          plan={modal.plan}
          onConfirm={() => setModal({ kind: 'subscribe', plan: modal.plan })}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'subscribe' && (
        <SubscribeModal
          plan={modal.plan}
          onClose={() => setModal({ kind: 'none' })}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Build billing plugin and verify zero errors**

```bash
cd plugins/agentbook-billing/frontend && npm run build 2>&1 | tail -30
```

Expected: `dist/production/agentbook-billing.js` generated, no TypeScript errors, no missing import errors.

- [ ] **Step 5: Copy built bundle to public CDN directory**

```bash
cp plugins/agentbook-billing/frontend/dist/production/agentbook-billing.js \
   apps/web-next/public/cdn/plugins/agentbook-billing/agentbook-billing.js
cp plugins/agentbook-billing/frontend/dist/production/agentbook-billing.js \
   apps/web-next/public/cdn/plugins/agentbook-billing/1.0.0/agentbook-billing.js
```

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-billing/frontend/src/user/UpgradeTimingModal.tsx \
        plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx \
        plugins/agentbook-billing/frontend/src/user/UserApp.tsx \
        apps/web-next/public/cdn/plugins/agentbook-billing/
git commit -m "feat(billing): upgrade timing modal + SubscribeModal step indicator + trial callout"
```

---

## Self-Review Checklist

- [x] Spec §1.1 (plan cards + feature list): Task 1 covers full feature checklist + quota display
- [x] Spec §1.2 (monthly/annual toggle): Task 1 adds interval toggle with savings badge
- [x] Spec §1.3 (upgrade timing choice): Task 2 adds proration API; Task 3 adds modal
- [x] Spec §1.4 (credit card flow polish): Task 3 replaces SubscribeModal with step indicator + trial callout
- [x] Type consistency: `ProratePreview` defined in api.ts Task 2, used in UpgradeTimingModal Task 3 via `import { meApi, type Plan, type ProratePreview }`
- [x] No placeholders
