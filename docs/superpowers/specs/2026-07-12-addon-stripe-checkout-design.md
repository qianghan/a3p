# Add-on Stripe payment-method collection — design

## Problem

`POST /api/v1/agentbook-billing/me/addons/[code]/subscribe` requires a real Stripe
`paymentMethodId` in its request body, but no UI anywhere in the codebase can produce
one for a BillAddOn purchase. The only visible add-on UI — the `startup_tax_benefits`
teaser on `StartupDiscoveryPage.tsx` — shows a price but has no working purchase
button. This blocks every current and future BillAddOn purchase flow, not just one
feature.

A working Stripe Elements card-collection flow already exists for **plan**
subscriptions (`plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx`,
using `loadStripe` + `Elements` + `PaymentElement` + `stripe.confirmSetup`), backed by
`POST /me/subscription/intent` which creates/reuses a Stripe customer and returns a
SetupIntent `clientSecret`. That endpoint has no dependency on plan identity — it's
generic customer/setup-intent plumbing — so it can be reused for add-on purchases
with no backend changes.

## Goals

- A reusable, Stripe Elements-based card-collection modal that any plugin frontend
  can use to purchase a BillAddOn.
- Wire it into the one concrete add-on consumer in this repo today:
  `startup_tax_benefits` on `StartupDiscoveryPage.tsx`.
- Leave the existing, working plan-subscribe flow (`SubscribeModal.tsx`) untouched —
  no refactor, no shared-component migration for that flow in this change.

## Non-goals

- `student_success` / `personal_insights` add-ons — not present in this worktree;
  they'll wire into the new shared component once they land.
- Jurisdiction-aware region selection for add-on pricing — the existing teaser fetch
  hardcodes `region=us`; the checkout flow keeps that precedent as-is.
- Real Stripe test-mode API verification — no test-mode Stripe keys exist in this
  Vercel project (Development/Preview have none; Production only has live keys).
  Verification uses a mocked `stripe.confirmSetup` response instead (see Testing).

## Architecture

### New component: `packages/ui/src/AddOnCheckoutModal.tsx`

Built on the existing `Modal` shell (`packages/ui/src/Modal.tsx`) and modeled
directly on `SubscribeModal.tsx`'s working pattern, generalized so it's decoupled
from any specific add-on or backend route:

```ts
interface AddOnCheckoutModalProps {
  title: string;                                        // e.g. "Startup Tax Benefits"
  priceLabel?: string;                                   // e.g. "$99/year — Founding Member"
  onClose: () => void;
  fetchClientSecret: () => Promise<{ clientSecret: string }>;
  onConfirmed: (paymentMethodId: string) => Promise<void>;
  onDone: () => void;
}
```

Behavior:
1. On mount, calls `fetchClientSecret()` to get a SetupIntent `clientSecret`.
2. Loads Stripe via `loadStripe(window.STRIPE_PUBLISHABLE_KEY)` — this global is
   already set in `apps/web-next/src/app/layout.tsx:83` from
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, so any plugin mounted in the host page can
   read it with no new plumbing.
3. Renders `Elements` (with the fetched `clientSecret`) wrapping a `PaymentElement`
   + submit button.
4. On submit: `stripe.confirmSetup({ elements, redirect: 'if_required' })` → extract
   `setupIntent.payment_method` (string or object `.id`) → call
   `onConfirmed(paymentMethodId)` → on success call `onDone()`.
5. Same busy/error state handling as `SubscribeModal.tsx` (disable submit while busy,
   surface Stripe/API errors inline).

Exported from `packages/ui/src/index.ts`.

### Dependencies

- `packages/ui/package.json`: add `@stripe/stripe-js` and `@stripe/react-stripe-js`
  as dependencies (matching the versions already used in
  `plugins/agentbook-billing/frontend/package.json`: `@stripe/stripe-js@^4.0.0`,
  `@stripe/react-stripe-js@^3.0.0`).
- `plugins/agentbook-startup/frontend/package.json`: add `@naap/ui: "*"` (currently
  not a dependency of this plugin's frontend).

### Backend — no changes

`POST /api/v1/agentbook-billing/me/subscription/intent` is reused as-is for the
add-on checkout's `fetchClientSecret`. `POST /api/v1/agentbook-billing/me/addons/[code]/subscribe`
is reused as-is for `onConfirmed`.

### Frontend wiring — `StartupDiscoveryPage.tsx`

`plugins/agentbook-startup/frontend/src/lib/api.ts` gains two functions:

```ts
getAddOnIntent: async (): Promise<{ clientSecret: string }> =>
  json(await fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })),

subscribeAddOn: async (paymentMethodId: string): Promise<void> => {
  await fetch('/api/v1/agentbook-billing/me/addons/startup_tax_benefits/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ region: 'us', paymentMethodId }),
  });
},
```

`StartupDiscoveryPage.tsx`: the teaser block (currently lines 303–311, text-only)
gets an "Upgrade" button when `teaser?.price && !teaser.active`. Clicking it opens
`AddOnCheckoutModal` with `fetchClientSecret={startupApi.getAddOnIntent}`,
`onConfirmed={startupApi.subscribeAddOn}`, and `onDone` re-fetching the teaser (so
the button disappears once `active` flips to `true`).

## Error handling

- `fetchClientSecret` failure (e.g. `/subscription/intent` 500): show inline error
  in the modal, keep it open, no retry loop (user can close and reopen).
- `confirmSetup` Stripe-side error (declined card, etc.): surface
  `error.message` inline, keep modal open, re-enable submit.
- `onConfirmed` failure (e.g. `/addons/.../subscribe` 502, add-on has no Stripe price
  for the region): surface the error inline; the SetupIntent has already succeeded
  at this point, so the user has a saved payment method but no active add-on — this
  matches the existing plan-subscribe flow's behavior (no special-cased recovery).

## Testing

Given no test-mode Stripe keys exist in this project (see Non-goals), verification
is a Playwright test against the local dev server:

1. Log in as a startup-persona test account, navigate to the Startup Tax Benefits
   discovery page.
2. Confirm the teaser renders an "Upgrade" button (add-on not active).
3. Click it; confirm the modal opens and `PaymentElement` mounts.
4. Stub `window.Stripe`'s `confirmSetup` (via `page.addInitScript` /
   `page.route`) to resolve a fake `setupIntent.payment_method` id, avoiding a real
   Stripe network call.
5. Submit; assert the `subscribe` request fires with a `paymentMethodId` in the
   body, and the UI transitions to the active state (button disappears / success
   state shown).

This proves the component wiring (intent → Elements → confirmSetup →
paymentMethodId → subscribe → UI update) end-to-end without exercising Stripe's real
API, since no test-mode credentials are available.

Existing unit test coverage
(`apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`)
already covers the `/subscribe` route itself and is unaffected by this change.
