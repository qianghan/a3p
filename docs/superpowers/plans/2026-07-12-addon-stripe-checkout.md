# Add-on Stripe Payment-Method Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable Stripe Elements card-collection modal and wire it into the `startup_tax_benefits` add-on purchase flow, so `POST /me/addons/[code]/subscribe` finally receives a real `paymentMethodId`.

**Architecture:** A new `AddOnCheckoutModal` component in `packages/ui` (built on the existing `Modal` shell, modeled on the working plan-subscribe `SubscribeModal.tsx` pattern: `loadStripe` + `Elements` + `PaymentElement` + `stripe.confirmSetup`). It's decoupled from any specific route via `fetchClientSecret`/`onConfirmed` props. `StartupDiscoveryPage.tsx` wires it up using the existing (unmodified) `/me/subscription/intent` and `/me/addons/[code]/subscribe` routes.

**Tech Stack:** React 19, Vite, Vitest + Testing Library + happy-dom, `@stripe/stripe-js` / `@stripe/react-stripe-js`, Prisma, Next.js API routes.

## Global Constraints

- `@stripe/stripe-js@^4.0.0` and `@stripe/react-stripe-js@^3.0.0` — exact versions already used by `plugins/agentbook-billing/frontend/package.json`; match them, don't introduce a second version.
- Do not modify `plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx` — out of scope per the approved design.
- Do not add any new backend route — reuse `POST /api/v1/agentbook-billing/me/subscription/intent` and `POST /api/v1/agentbook-billing/me/addons/[code]/subscribe` as-is.
- Region stays hardcoded to `'us'` in the new checkout call, matching the existing teaser fetch's precedent (`startupApi.getAddOnTeaser`).
- Every new/changed `lib/api.ts` method needs its own `global.fetch`-mocking test (not just page-level tests that mock the whole module) — a prior real bug (`json(fetch(url))` instead of `json(await fetch(url))`) shipped in this exact file, `plugins/agentbook-startup/frontend/src/lib/api.ts`, and every page-level test still passed because they mock the whole module.
- Stripe sandbox test keys live only in `apps/web-next/.env.local` (git-ignored) — never commit them, never add them to a Vercel environment as part of this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/ui/package.json` | Modify — add Stripe deps |
| `packages/ui/src/AddOnCheckoutModal.tsx` | Create — the shared checkout modal |
| `packages/ui/src/index.ts` | Modify — export it |
| `plugins/agentbook-startup/frontend/package.json` | Modify — add `@naap/ui` dep |
| `plugins/agentbook-startup/frontend/src/lib/api.ts` | Modify — add `getAddOnIntent` / `subscribeAddOn` |
| `plugins/agentbook-startup/frontend/src/__tests__/api.test.ts` | Create — fetch-mocking test for the two new client methods |
| `plugins/agentbook-startup/frontend/src/__tests__/AddOnCheckoutModal.test.tsx` | Create — unit test for the shared component, imported via `@naap/ui` |
| `plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx` | Modify — Upgrade button + modal wiring |
| `plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx` | Modify — cover the new button/modal flow |
| `apps/web-next/.env.local` | Local-only — Stripe sandbox keys + `ADMIN_EMAILS` (not committed) |
| `apps/web-next/public/cdn/plugins/agentbook-startup/**` | Rebuilt UMD bundle |

**Cut from an earlier draft of this plan:** a Playwright e2e spec driving the real Stripe `PaymentElement` iframe. Rejected because no test-mode Stripe keys exist in any Vercel environment (Development/Preview have none, Production is live-only — confirmed via `vercel env ls`), so it could only ever run manually on a machine with a hand-provisioned sandbox `.env.local`. That means it would never run in CI, and its iframe selector would need to be guessed and hand-corrected against a specific Stripe.js version. That combination — can't run automatically, breaks silently on the next Stripe.js update — makes it a maintenance liability rather than a safety net. Task 6's manual browser pass with a real Stripe test card already delivers the actual proof this project needs; the unit/component suite (Tasks 2–4) is what actually runs in CI going forward.

---

### Task 1: Add Stripe dependency to `@naap/ui`, wire `agentbook-startup` to consume it

**Files:**
- Modify: `packages/ui/package.json`
- Modify: `plugins/agentbook-startup/frontend/package.json`

**Interfaces:**
- Produces: `@stripe/stripe-js` and `@stripe/react-stripe-js` resolvable from anywhere under `packages/ui/src/**`; `@naap/ui` resolvable as an import from `plugins/agentbook-startup/frontend/src/**` (already true for `plugins/agentbook-invoice`, `agentbook-core`, `agentbook-expense`, `agentbook-tax` — this plugin didn't have it yet).

- [ ] **Step 1: Add Stripe as a regular dependency of `@naap/ui`**

Edit `packages/ui/package.json`:

```json
{
  "name": "@naap/ui",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "private": true,
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "dependencies": {
    "@stripe/stripe-js": "^4.0.0",
    "@stripe/react-stripe-js": "^3.0.0"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "framer-motion": "^12.0.0",
    "lucide-react": ">=0.460.0"
  }
}
```

(Stripe packages go in `dependencies`, not `peerDependencies` — consumers get them transitively without declaring their own copy, same as how `agentbook-billing`'s `SubscribeModal.tsx` already depends on them directly today.)

- [ ] **Step 2: Add `@naap/ui` as a dependency of `agentbook-startup`'s frontend**

Edit `plugins/agentbook-startup/frontend/package.json`, in the `dependencies` block:

```json
  "dependencies": {
    "@naap/plugin-sdk": "*",
    "@naap/plugin-build": "*",
    "@naap/ui": "*",
    "lucide-react": "^0.575.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
```

- [ ] **Step 3: Install**

Run: `npm install` (from repo root)
Expected: lockfile updates, no errors. Verify resolution:

Run: `ls node_modules/@stripe/stripe-js node_modules/@stripe/react-stripe-js`
Expected: both directories exist (hoisted to root `node_modules` via the npm workspace).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/package.json plugins/agentbook-startup/frontend/package.json package-lock.json
git commit -m "build: add Stripe deps to @naap/ui, wire agentbook-startup to consume it"
```

---

### Task 2: Build the shared `AddOnCheckoutModal` component (TDD)

**Files:**
- Create: `packages/ui/src/AddOnCheckoutModal.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `plugins/agentbook-startup/frontend/src/__tests__/AddOnCheckoutModal.test.tsx` (colocated in the first consuming plugin — `packages/ui` itself has no test runner of its own; none of its existing components (`Modal`, `Button`, etc.) have dedicated tests either, so this follows the codebase's existing convention of testing shared components at their point of use)

**Interfaces:**
- Consumes: `Modal` from `./Modal` (props: `isOpen: boolean`, `onClose: () => void`, `title?: string`, `description?: string`, `children`, `size?: 'sm'|'md'|'lg'|'xl'|'full'`).
- Produces:
  ```ts
  export interface AddOnCheckoutModalProps {
    title: string;
    priceLabel?: string;
    onClose: () => void;
    fetchClientSecret: () => Promise<{ clientSecret: string }>;
    onConfirmed: (paymentMethodId: string) => Promise<void>;
    onDone: () => void;
  }
  export function AddOnCheckoutModal(props: AddOnCheckoutModalProps): JSX.Element;
  ```
  Exported from `@naap/ui`. Task 4 imports and uses this directly.

- [ ] **Step 1: Write the failing test**

Create `plugins/agentbook-startup/frontend/src/__tests__/AddOnCheckoutModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AddOnCheckoutModal } from '@naap/ui';

const mockConfirmSetup = vi.fn();

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
}));

beforeEach(() => {
  mockConfirmSetup.mockReset();
});

describe('AddOnCheckoutModal', () => {
  it('shows a loading state, then the PaymentElement once the client secret resolves', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        priceLabel="$99/year"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText(/preparing checkout/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
  });

  it('shows an error if fetching the client secret fails', async () => {
    const fetchClientSecret = vi.fn().mockRejectedValue(new Error('no customer'));
    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('no customer')).toBeTruthy());
  });

  it('confirms setup, calls onConfirmed with the payment method id, then onDone', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    const onConfirmed = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    mockConfirmSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_test_123' } });

    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={onConfirmed}
        onDone={onDone}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('pm_test_123'));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('shows an inline error when confirmSetup fails and does not call onConfirmed', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    const onConfirmed = vi.fn();
    mockConfirmSetup.mockResolvedValue({ error: { message: 'Your card was declined.' } });

    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={onConfirmed}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(screen.getByText('Your card was declined.')).toBeTruthy());
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/AddOnCheckoutModal.test.tsx`
Expected: FAIL — `No "AddOnCheckoutModal" export is defined on the "@naap/ui" mock` or a module resolution error (the file doesn't exist yet).

- [ ] **Step 3: Implement the component**

Create `packages/ui/src/AddOnCheckoutModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
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
}: Pick<AddOnCheckoutModalProps, 'onConfirmed' | 'onDone'>): JSX.Element {
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
}: AddOnCheckoutModalProps): JSX.Element {
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
```

- [ ] **Step 4: Export it from the package index**

Edit `packages/ui/src/index.ts`, add near the `Modal` export:

```ts
export { Modal, type ModalProps } from './Modal';
export { AddOnCheckoutModal, type AddOnCheckoutModalProps } from './AddOnCheckoutModal';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/AddOnCheckoutModal.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/AddOnCheckoutModal.tsx packages/ui/src/index.ts plugins/agentbook-startup/frontend/src/__tests__/AddOnCheckoutModal.test.tsx
git commit -m "feat(ui): add shared Stripe Elements AddOnCheckoutModal"
```

---

### Task 3: Add `startupApi` checkout methods (TDD, fetch-mocking test)

**Files:**
- Modify: `plugins/agentbook-startup/frontend/src/lib/api.ts`
- Create: `plugins/agentbook-startup/frontend/src/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `json<T>(r: Response): Promise<T>` (existing private helper in `api.ts`, already used by every other method — throws `${status} ${bodyText}` when `!r.ok`).
- Produces:
  ```ts
  getAddOnIntent: () => Promise<{ clientSecret: string; customerId: string }>
  subscribeAddOn: (paymentMethodId: string) => Promise<void>
  ```
  Task 4 passes `startupApi.getAddOnIntent` as `fetchClientSecret` and `startupApi.subscribeAddOn` as `onConfirmed` to `AddOnCheckoutModal`.

- [ ] **Step 1: Write the failing test**

Create `plugins/agentbook-startup/frontend/src/__tests__/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startupApi } from '../lib/api';

describe('startupApi add-on checkout methods', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getAddOnIntent posts to the billing subscription intent route and returns the client secret', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ clientSecret: 'seti_123_secret_abc', customerId: 'cus_1' }),
    });

    const result = await startupApi.getAddOnIntent();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/agentbook-billing/me/subscription/intent',
      { method: 'POST' },
    );
    expect(result.clientSecret).toBe('seti_123_secret_abc');
  });

  it('getAddOnIntent throws with the response body on a non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'no customer; call /me/subscription/intent first',
    });

    await expect(startupApi.getAddOnIntent()).rejects.toThrow('no customer');
  });

  it('subscribeAddOn posts region + paymentMethodId to the startup_tax_benefits subscribe route', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, subscriptionId: 'sub_1', tier: 'founding_member' }),
    });

    await startupApi.subscribeAddOn('pm_test_123');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/agentbook-billing/me/addons/startup_tax_benefits/subscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: 'us', paymentMethodId: 'pm_test_123' }),
      },
    );
  });

  it('subscribeAddOn throws with the response body on a non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'subscribe failed',
    });

    await expect(startupApi.subscribeAddOn('pm_test_123')).rejects.toThrow('subscribe failed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/api.test.ts`
Expected: FAIL — `startupApi.getAddOnIntent is not a function`

- [ ] **Step 3: Implement the methods**

Edit `plugins/agentbook-startup/frontend/src/lib/api.ts`, add to the `startupApi` object (next to `getAddOnTeaser`):

```ts
  getAddOnIntent: async (): Promise<{ clientSecret: string; customerId: string }> =>
    json(await fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })),
  subscribeAddOn: async (paymentMethodId: string): Promise<void> => {
    await json(await fetch('/api/v1/agentbook-billing/me/addons/startup_tax_benefits/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'us', paymentMethodId }),
    }));
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-startup/frontend/src/lib/api.ts plugins/agentbook-startup/frontend/src/__tests__/api.test.ts
git commit -m "feat(startup): add getAddOnIntent/subscribeAddOn API client methods"
```

---

### Task 4: Wire `AddOnCheckoutModal` into `StartupDiscoveryPage`

**Files:**
- Modify: `plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx`
- Modify: `plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx`

**Interfaces:**
- Consumes: `AddOnCheckoutModal` (Task 2), `startupApi.getAddOnIntent` / `startupApi.subscribeAddOn` (Task 3), existing `startupApi.getAddOnTeaser` / `AddOnPriceTeaser` / `formatCents`.

- [ ] **Step 1: Write the failing tests**

Edit `plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx`. Add the mock for `@naap/ui` near the top (after the existing `vi.mock('../lib/api', ...)` block):

```tsx
vi.mock('@naap/ui', () => ({
  AddOnCheckoutModal: ({
    onDone, onClose, title,
  }: { onDone: () => void; onClose: () => void; title: string }) => (
    <div data-testid="addon-checkout-modal">
      <span>{title}</span>
      <button onClick={onDone}>mock-confirm</button>
      <button onClick={onClose}>mock-close</button>
    </div>
  ),
}));
```

Add these tests inside the existing `describe('StartupDiscoveryPage', ...)` block:

```tsx
  it('shows an Upgrade button when the add-on is not active, and opens the checkout modal', async () => {
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    const upgradeButton = await screen.findByRole('button', { name: /upgrade/i });
    fireEvent.click(upgradeButton);
    expect(screen.getByTestId('addon-checkout-modal')).toBeTruthy();
  });

  it('re-fetches the teaser and closes the modal once checkout completes', async () => {
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /upgrade/i }));
    getAddOnTeaser.mockResolvedValue({ active: true, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
    fireEvent.click(screen.getByText('mock-confirm'));
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('addon-checkout-modal')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull());
  });

  it('does not show the Upgrade button once the add-on is already active', async () => {
    getAddOnTeaser.mockResolvedValue({ active: true, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/StartupDiscoveryPage.test.tsx`
Expected: FAIL — no "Upgrade" button exists yet (`Unable to find role="button" with name /upgrade/i`)

- [ ] **Step 3: Implement the wiring**

Edit `plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx`. Add the import (line 8 area):

```tsx
import { AddOnCheckoutModal } from '@naap/ui';
```

Add state near the other `useState` calls (around line 133):

```tsx
  const [showCheckout, setShowCheckout] = useState(false);
```

Replace the teaser block (currently lines 303–311) with:

```tsx
      {teaser?.price && !teaser.active && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mt-6 flex items-start gap-2">
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">
              Ready to draft an application? Startup Tax Benefits starts at{' '}
              <span className="font-medium text-foreground">{formatCents(teaser.price.priceCents)}/year</span>.
            </p>
            <button
              type="button"
              onClick={() => setShowCheckout(true)}
              className="mt-2 text-sm font-medium text-primary hover:underline"
            >
              Upgrade
            </button>
          </div>
        </div>
      )}

      {showCheckout && (
        <AddOnCheckoutModal
          title="Startup Tax Benefits"
          priceLabel={teaser?.price ? `${formatCents(teaser.price.priceCents)}/year` : undefined}
          onClose={() => setShowCheckout(false)}
          fetchClientSecret={startupApi.getAddOnIntent}
          onConfirmed={startupApi.subscribeAddOn}
          onDone={() => {
            setShowCheckout(false);
            startupApi.getAddOnTeaser().then(setTeaser).catch(() => setTeaser(null));
          }}
        />
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/StartupDiscoveryPage.test.tsx`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Run the full plugin test suite to check for regressions**

Run: `cd plugins/agentbook-startup/frontend && npm run test`
Expected: PASS, no regressions

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx
git commit -m "feat(startup): wire AddOnCheckoutModal into the tax-benefits upgrade flow"
```

---

### Task 5: Local Stripe sandbox setup + provision a real test-mode Price

**Files:**
- Modify: `apps/web-next/.env.local` (local-only, git-ignored)
- No source files change in this task — this is local environment/data setup required before Task 6's browser verification can succeed.

**Why this task exists:** `bin/seed-startup-benefit-addon.ts` seeds `BillAddOnPrice` rows with `stripePriceId: null`. `resolveAddOnPrice` returning a row with no `stripePriceId` makes `/me/addons/[code]/subscribe` return 400 ("add-on has no Stripe price configured for this region yet"). This must be fixed locally before the checkout flow can complete.

**Interfaces:**
- Consumes: `POST /api/v1/agentbook-billing/addons/[code]/prices/[priceId]` (existing admin route, unmodified — creates a Stripe Product + Price with whatever `STRIPE_SECRET_KEY` is configured, and persists `stripePriceId` on the row).

- [ ] **Step 1: Confirm sandbox keys and admin allowlist are in place**

`apps/web-next/.env.local` must contain (already added earlier this session):

```
STRIPE_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."
```

Add the admin allowlist line (uncomment from `.env.local.example:116`):

```
ADMIN_EMAILS=admin@a3p.io
```

- [ ] **Step 2: Start the local stack**

Run (per `CLAUDE.md` Quick Start — database, 4 backends, frontend):

```bash
docker compose up -d database
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx --no prisma db push --skip-generate
cd ../..

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4050 npx tsx plugins/agentbook-core/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PLAID_CLIENT_ID="69d02fa4f1949b000dbfc51e" PLAID_SECRET="59be40029c47288c4db4acfd79ae56" PLAID_ENV="sandbox" PORT=4051 npx tsx plugins/agentbook-expense/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4052 npx tsx plugins/agentbook-invoice/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4053 npx tsx plugins/agentbook-tax/backend/src/server.ts &

cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npm run dev &
cd ../..
```

Expected: all processes start without error; `http://localhost:3000` responds.

- [ ] **Step 3: Seed users, personas, and the startup add-on prices**

```bash
npx tsx agentbook/seed-users.ts
npx tsx agentbook/seed-personas.ts
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" npx tsx bin/sync-plugin-registry.ts
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" npx tsx bin/seed-agentbook-defaults.ts
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" npx tsx bin/seed-startup-benefit-addon.ts
```

Expected: each script exits 0. Confirm the price row exists with no Stripe id yet:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" npx tsx -e "
import { prisma } from '@naap/database';
(async () => {
  const addOn = await prisma.billAddOn.findUnique({ where: { code: 'startup_tax_benefits' } });
  const price = await prisma.billAddOnPrice.findFirst({ where: { addOnId: addOn.id, region: 'us', tier: 'founding_member' } });
  console.log(JSON.stringify(price));
  await prisma.\$disconnect();
})();
"
```

Expected: prints a row with `"stripePriceId":null`. Note the `id` value — call it `PRICE_ID` below.

- [ ] **Step 4: Log in as admin and provision the Stripe test-mode Price**

Use your scratchpad directory for the cookie jar file (referred to below as `$COOKIE_JAR` — substitute your actual scratchpad path, e.g. `$COOKIE_JAR=/path/to/your/scratchpad/cookies.txt`):

```bash
curl -s -c "$COOKIE_JAR" \
  -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@a3p.io","password":"a3p-dev"}'
```

Expected: `200` with a `user` object in the body; cookie jar now has `naap_auth_token`.

```bash
curl -s -b "$COOKIE_JAR" \
  -X POST "http://localhost:3000/api/v1/agentbook-billing/addons/startup_tax_benefits/prices/PRICE_ID" \
  -H 'content-type: application/json' -d '{}'
```

(replace `PRICE_ID` with the value from Step 3)

Expected: `200` with `{"price": {..., "stripePriceId": "price_..."}}`. Re-run the Step 3 query to confirm `stripePriceId` is now set.

- [ ] **Step 5: No commit** — this task changes only local runtime state (DB row + `.env.local`), nothing tracked by git.

---

### Task 6: Manual end-to-end verification in a real browser against Stripe sandbox

**Files:** none changed — this is a verification task, driven with the Browser tool.

- [ ] **Step 1: Build and deploy the plugin bundle locally**

```bash
cd plugins/agentbook-startup/frontend && npm run build
cp dist/production/agentbook-startup.js ../../../apps/web-next/public/cdn/plugins/agentbook-startup/agentbook-startup.js
cp dist/production/agentbook-startup.js ../../../apps/web-next/public/cdn/plugins/agentbook-startup/1.0.0/agentbook-startup.js
cd ../../..
```

Expected: build succeeds, "✅ Validated: no bundled React internals" printed, both copy targets updated.

- [ ] **Step 2: Drive the flow in the browser**

Using the Browser tool against `http://localhost:3000`:
1. Log in as `admin@a3p.io` / `a3p-dev` (or any persona with the startup plugin enabled — confirm via the plugin list if the Startup Tax Benefits page 404s).
2. Navigate to the Startup Tax Benefits discovery page.
3. Confirm the teaser shows an "Upgrade" button (add-on not yet active for this tenant).
4. Click it — confirm the modal opens, title reads "Startup Tax Benefits", and a real Stripe `PaymentElement` renders (not the "Preparing checkout…" placeholder, and no inline error).
5. Fill in the Stripe test card: number `4242 4242 4242 4242`, any future expiry (e.g. `12/34`), any 3-digit CVC, any ZIP if prompted. Use `read_page`/`find` to locate the actual input fields at runtime (Stripe renders these inside an iframe whose exact title varies by Stripe.js version — inspect live rather than guessing).
6. Submit. Confirm: no inline error, the modal closes, and the teaser section changes to reflect the add-on is now active (Upgrade button gone).

- [ ] **Step 3: Confirm the round trip against Stripe's real API**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" npx tsx -e "
import { prisma } from '@naap/database';
(async () => {
  const addOn = await prisma.billAddOn.findUnique({ where: { code: 'startup_tax_benefits' } });
  const sub = await prisma.billAddOnSubscription.findFirst({
    where: { addOnId: addOn.id },
    orderBy: { updatedAt: 'desc' },
  });
  console.log(JSON.stringify(sub));
  await prisma.\$disconnect();
})();
"
```

Expected: a row with `status: 'active'` and a real `stripeSubscriptionId` (`sub_...`), for the account/tenant used in Step 2. Optionally confirm directly against Stripe with the sandbox secret key:

```bash
curl -s https://api.stripe.com/v1/subscriptions/SUB_ID -u "$STRIPE_SECRET_KEY:"
```

Expected: `200`, `"status": "active"`.

- [ ] **Step 4: Note anything that didn't match expectations**

If the modal, teaser wiring, or error states behaved differently than Tasks 2–4 assumed, note it here for a follow-up fix — don't silently accept a mismatch between what was built and what was actually observed working.

---

### Task 7: Final verification

**Files:** none changed — this task only runs checks.

- [ ] **Step 1: Typecheck the changed packages**

```bash
cd packages/ui && npx tsc --noEmit
cd ../../plugins/agentbook-startup/frontend && npx tsc --noEmit
```

Expected: both exit 0, no type errors. (If either package has no standalone `tsconfig` entry point for `--noEmit`, use its existing `tsconfig.json` via `npx tsc --noEmit -p tsconfig.json` instead.)

- [ ] **Step 2: Run the full test suite for the changed plugin**

```bash
cd plugins/agentbook-startup/frontend && npm run test
```

Expected: PASS — all tests, including the 3 new files/additions from Tasks 2–4, with no regressions in the pre-existing suite.

- [ ] **Step 3: Confirm the production build is clean**

```bash
cd plugins/agentbook-startup/frontend && npm run build
```

Expected: succeeds, "✅ Validated: no bundled React internals" printed (already done once in Task 6, Step 1 — re-run here to confirm it's still clean after any fixes from Task 6, Step 4).

- [ ] **Step 4: Commit the rebuilt UMD bundle if anything changed since Task 6**

```bash
git status apps/web-next/public/cdn/plugins/agentbook-startup
# if changed:
git add apps/web-next/public/cdn/plugins/agentbook-startup
git commit -m "build(startup): rebuild UMD bundle with add-on checkout flow"
```

---

## Definition of Done

- [ ] `cd plugins/agentbook-startup/frontend && npm run test` passes, including the new `AddOnCheckoutModal.test.tsx`, `api.test.ts`, and the 3 added `StartupDiscoveryPage.test.tsx` cases.
- [ ] `npx tsc --noEmit` is clean for `packages/ui` and `plugins/agentbook-startup/frontend`.
- [ ] A real browser session (Task 6) completed checkout with the Stripe test card `4242 4242 4242 4242` end-to-end: no inline errors, the Upgrade button disappears, and the `BillAddOnSubscription` row shows `status: 'active'` with a real `stripeSubscriptionId`.
- [ ] The UMD bundle at `apps/web-next/public/cdn/plugins/agentbook-startup/` reflects the final code and is committed.
- [ ] `SubscribeModal.tsx` is untouched; no new backend route was added; region stayed hardcoded to `'us'`.
- [ ] No Stripe secret ever appears in a committed file (`apps/web-next/.env.local` stays git-ignored and local-only).

## Spec Coverage Check

- Reusable `AddOnCheckoutModal` in `packages/ui` → Task 2.
- Wired into `startup_tax_benefits` (the only real consumer in this repo) → Task 4.
- `SubscribeModal.tsx` left untouched → enforced by Global Constraints; no task touches it.
- No new backend route; reuse `/me/subscription/intent` and `/me/addons/[code]/subscribe` → Task 3 calls both as-is.
- Region hardcoded to `'us'` → Task 3, `subscribeAddOn`.
- Fetch-mocking test per new API client method → Task 3.
- Local Stripe sandbox setup + the `stripePriceId` provisioning gap found during design → Task 5.
- Real Stripe test-mode verification (not mocked) → Task 6, manual browser pass against the actual Stripe sandbox API (a Playwright automation of this was considered and cut — see File Structure note — since it can't run in CI and would rot unmaintained).
- Production needs no code change (Vercel already injects live keys) → nothing to build; already true today, confirmed with the user.
