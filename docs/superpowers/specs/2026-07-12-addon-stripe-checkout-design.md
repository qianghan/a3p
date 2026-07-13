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
- Adding Stripe test-mode keys to Vercel's Development/Preview environment — a
  sandbox key pair was provided for this change and is used locally only (see
  Testing / Local setup). Wiring them into Vercel so future sessions/CI have them
  is a separate decision, not done as part of this change.
- Flipping the add-on subscribe flow to live mode — Production already has live
  Stripe keys configured (`STRIPE_SECRET_KEY`/`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`),
  so once this change is deployed, add-on purchases in production use them
  automatically. No separate "go live" step is needed in this change.

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

A Stripe test-mode (sandbox) key pair is now available and is used for a real
end-to-end verification against Stripe's actual test-mode API — not a mock.

### Local setup

- `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (both `_test_`) go in
  `apps/web-next/.env.local` (git-ignored, not committed).
- **Gap found during design:** `bin/seed-startup-benefit-addon.ts` seeds
  `BillAddOnPrice` rows with `stripePriceId: null` — it never provisions the Stripe
  side. `resolveAddOnPrice` returning a row with no `stripePriceId` makes
  `/me/addons/[code]/subscribe` 400 with "add-on has no Stripe price configured for
  this region yet." Before the e2e flow can succeed locally, the `us` /
  `founding_member` row for `startup_tax_benefits` needs a real test-mode Stripe
  Price. The existing admin route
  `POST /api/v1/agentbook-billing/addons/[code]/prices/[priceId]/route.ts` already
  does exactly this (creates a Stripe Product + Price with the configured secret
  key, stores `stripePriceId` on the row) — call it once locally (as an admin
  session) against the seeded row's id before testing.

### End-to-end flow (Playwright, against local dev server)

1. Log in as a startup-persona test account, navigate to the Startup Tax Benefits
   discovery page.
2. Confirm the teaser renders an "Upgrade" button (add-on not active).
3. Click it; confirm the modal opens and `PaymentElement` mounts.
4. Fill the Stripe test card (`4242 4242 4242 4242`, any future expiry, any CVC/ZIP)
   into the real `PaymentElement` iframe and submit.
5. Confirm `stripe.confirmSetup` succeeds against Stripe's real test-mode API,
   `subscribe` fires with the resulting `paymentMethodId`, and the UI transitions to
   the active state (button disappears / success state shown).
6. Confirm in Stripe's test-mode dashboard (or via the Stripe API with the sandbox
   key) that a subscription was created against the sandbox customer — this
   verifies the full round trip, not just the UI.

This proves the component wiring (intent → Elements → confirmSetup →
paymentMethodId → subscribe → UI update) end-to-end through Stripe's real
sandbox, since test-mode credentials are now available.

Existing unit test coverage
(`apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`)
already covers the `/subscribe` route itself and is unaffected by this change.
