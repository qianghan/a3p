# AgentBook Billing Plugin — Design

**Status:** Approved 2026-05-12
**Owner:** Platform / AgentBook
**Deployment target:** Vercel (primary), Node 24 / Fluid Compute

## Problem

AgentBook needs a billing layer so operators can monetize the product: define subscription plans, accept payments, gate features and meter usage. Today the product is free for everyone with no enforcement. This plugin introduces:

- An **admin UI** (mounted at `/admin/billing`) where AgentBook operators (e.g., `admin@a3p.io`) create plans from templates and manage active plans.
- A **user UI** (mounted at `/billing`) where AgentBook users (Maya, Alex, Jordan) see their plan, usage, and upgrade with a credit card.
- A **shared library** (`@naap/billing`) the other agentbook plugins import for hot-path entitlement checks (`canUseFeature`, `checkQuota`, `incrementUsage`).
- A **Stripe webhook** that keeps local state in sync with Stripe (subscriptions, invoices, payment failures).

The plugin is mostly self-contained. Other plugins integrate by importing the shared library.

## Goals

- Operator can stand up a 3-tier pricing model (Free / Pro / Business) in under 10 minutes from seed templates.
- Users can subscribe end-to-end (click → pay → upgraded plan active) in under 90 seconds.
- Hot-path entitlement checks add **< 1 ms** overhead in steady state (cache-hit) and **< 30 ms** on cache miss.
- Stripe is the source of truth for billing; our DB mirrors it via webhook. No double-charges; no silent gating bypass.
- Existing data model survives the future addition of multi-user teams without schema breaking changes.
- Works on Vercel out of the box — no separate backend service to deploy.

## Non-goals (v1)

| Deferred | Why |
|---|---|
| Multi-user team billing | Extension point designed in (`accountId`, `resolveAccountId`); ship when team UX lands |
| Annual plans / proration | Add a second `BillPrice` per plan when needed |
| Coupons / promo codes | Stripe Coupons + Promotion Codes are a fast follow-up |
| Stripe Tax / VAT | One-click in Stripe Dashboard when first international user signs up |
| Custom invoice PDFs | Stripe-branded invoices cover v1 |
| Custom dunning emails | Stripe defaults (4 retries over 21 days) are sufficient |
| Self-serve refunds | Admin issues via Stripe Dashboard |
| Multi-currency | Default `usd` until first international plan is needed |
| Per-seat quotas | Per-account only today |
| A/B price testing | Stripe Pricing Tables when traffic justifies it |

## Pricing model (decisions captured during brainstorming)

| Decision | Choice |
|---|---|
| Plan type | **Hybrid** — tier-gated features + soft usage quotas |
| Metered dimensions (5) | `expenses_created`, `ocr_scans`, `ai_messages`, `invoices_sent`, `bank_connections` |
| Tier-gated features (3) | `telegram_bot`, `tax_package_generation`, `multi_user_teams` |
| Payment UX | **Stripe Payment Element** (embedded in modal on `/billing`) |
| Seed templates | **3-tier with permanent Free**: Free / Pro / Business |
| Invoice delivery | **Stripe-native with light branding** (logo + accent color via Stripe Dashboard) |
| Cancellation | Self-service, end-of-period (Stripe's `cancel_at_period_end`) |

### Seed template defaults (admin can edit at any time)

| Plan | Price | `telegram_bot` | `tax_package` | `teams` | `expenses` | `ocr` | `ai_msgs` | `invoices` | `bank_conn` |
|---|---|---|---|---|---|---|---|---|---|
| Free | $0/mo | ❌ | ❌ | ❌ | 50 | 10 | 100 | 5 | 0 |
| Pro | $19/mo | ✅ | ✅ | ❌ | 1000 | 200 | 5000 | 200 | 3 |
| Business | $49/mo | ✅ | ✅ | 🚧 (coming soon) | 10000 | -1 (∞) | -1 | -1 | -1 |

`-1` = unlimited. Quotas reset on each Stripe billing period end (Free tier resets monthly via cron).

## Architecture

### Three pieces

1. **Plugin** (`plugins/agentbook-billing/`)
   - `plugin.json` — manifest for the platform plugin registry
   - `frontend/` — Vite UMD bundle with two mount routes: `/admin/billing` (admin) and `/billing` (user). Built and served from `apps/web-next/public/cdn/plugins/agentbook-billing/agentbook-billing.js`.
   - **No `backend/` Express server.** All backend logic is Next.js route handlers (see below).

2. **Backend routes** (Next.js handlers under `apps/web-next/src/app/api/v1/agentbook-billing/`)
   - Vercel-native — each route handler is a Vercel Function on Fluid Compute
   - Uses Prisma directly via `@naap/database`
   - Uses Stripe SDK via `packages/billing/src/stripe.ts` wrapper

3. **Shared library** (`packages/billing/`)
   - New monorepo workspace package `@naap/billing`
   - Imported by `agentbook-core/backend`, `agentbook-expense/backend`, `agentbook-invoice/backend`, `agentbook-tax/backend`, and the Next.js Telegram webhook
   - Exports a small typed API (`canUseFeature`, `checkQuota`, `incrementUsage`, `getCurrentPlan`, `resolveAccountId`)
   - In-process 24h cache keeps hot-path checks free

### Stripe webhook

Lives at `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/route.ts` — outside the plugin namespace because Stripe wants exactly one URL per environment and signature verification needs Next.js raw-body handling. Thin handler: verify signature → insert `BillEvent` for idempotency → call library function to apply state change → invalidate cache.

### Why this deviates from existing plugins (and recommendation)

The four existing agentbook plugins (`-core`, `-expense`, `-invoice`, `-tax`) each run an Express server on a dev port (4050–4053) and are proxied by Next.js `[...path]/route.ts` files. That pattern requires a separate backend deployment in production.

`agentbook-billing` skips the Express layer entirely — backend routes are Next.js handlers — because:
- Vercel is the primary deployment target; long-running Express servers don't deploy there natively
- The Stripe webhook must be a Next.js route anyway (raw-body signature verification)
- A monetization layer benefits from being inside the same runtime as auth resolution

**Recommendation for future plugins:** document this Vercel-native pattern in `agentbook/skills/architecture.md` so subsequent plugins follow the same shape.

## Data model

Four new Prisma models in a new schema namespace `plugin_agentbook_billing`. All live in `packages/database/prisma/schema.prisma`.

### `BillPlan`

One row per plan the admin configured. Soft-archived plans (`isActive = false`) cannot be subscribed to anew but existing subscriptions continue working.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `code` | `String @unique` | `'free'`, `'pro'`, `'business'`, or admin-set |
| `name` | `String` | Display name |
| `description` | `String?` | Marketing copy |
| `priceCents` | `Int` | Display only; Stripe is billing source of truth |
| `currency` | `String @default("usd")` | |
| `interval` | `String @default("month")` | `'month' \| 'year'` |
| `stripeProductId` | `String?` | Set after Stripe API call succeeds |
| `stripePriceId` | `String?` | Set after Stripe API call succeeds |
| `features` | `Json` | `{ telegram_bot: bool, tax_package_generation: bool, multi_user_teams: bool }` |
| `quotas` | `Json` | `{ expenses_created: int, ocr_scans: int, ai_messages: int, invoices_sent: int, bank_connections: int }` — `-1` = unlimited |
| `isActive` | `Boolean @default(true)` | |
| `sortOrder` | `Int @default(0)` | Display order on /billing |
| `createdAt`, `updatedAt` | `DateTime` | |

### `BillSubscription`

Exactly one row per billing account. **Today `accountId` always equals an AgentBook `tenantId`** (one user = one account). The naming sets up future team-billing support without a schema migration.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `accountId` | `String @unique` | Billing account identity; v1 = tenantId |
| `planId` | `String` | FK → BillPlan.id |
| `status` | `String` | mirrors Stripe: `active \| trialing \| past_due \| canceled \| incomplete` |
| `stripeCustomerId` | `String?` | null for Free tier |
| `stripeSubscriptionId` | `String?` | null for Free tier |
| `currentPeriodStart` | `DateTime?` | drives quota reset |
| `currentPeriodEnd` | `DateTime?` | drives quota reset |
| `cancelAtPeriodEnd` | `Boolean @default(false)` | self-service cancel toggle |
| `canceledAt` | `DateTime?` | when user clicked Cancel |
| `createdAt`, `updatedAt` | `DateTime` | |

Index: `@@index([status])` for the admin ops view.

### `BillUsageCounter`

Per-account, per-dimension, per-period counter. `incrementUsage` upserts and bumps `count`.

| Field | Type |
|---|---|
| `id` | `String @id @default(uuid())` |
| `accountId` | `String` |
| `dimension` | `String` |
| `periodStart` | `DateTime` |
| `count` | `Int @default(0)` |
| `updatedAt` | `DateTime @updatedAt` |

Constraint: `@@unique([accountId, dimension, periodStart])`. Old period rows pruned by weekly cron after 90 days.

### `BillEvent`

Append-only Stripe webhook log. `stripeEventId` unique → re-delivery is a no-op.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `accountId` | `String?` | null for system events |
| `stripeEventId` | `String @unique` | Stripe `evt_xxx` |
| `eventType` | `String` | `'invoice.paid'`, `'customer.subscription.updated'`, etc. |
| `payload` | `Json` | raw event for debugging |
| `processedAt` | `DateTime?` | when handler completed |
| `createdAt` | `DateTime @default(now())` | |

### Forward-compat for team billing

When teams ship later:

1. Add `BillSeat` model — `(id, accountId, tenantId @unique, addedAt, role)`. The `@unique` on tenantId enforces "a user is in at most one billing team."
2. Add admin routes `POST /accounts/:id/seats` and `DELETE /accounts/:id/seats/:tenantId`.
3. Change `resolveAccountId(tenantId)` from `return tenantId` to: check `BillSeat` first, fall back to tenantId.

No consumer plugin changes. No `BillSubscription` migration.

## Backend routes (Next.js handlers)

All under `apps/web-next/src/app/api/v1/agentbook-billing/`. Auth resolution via existing `resolveAgentbookTenant(request)` helper.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/plans` | GET | any user | List active plans (for /billing page) |
| `/templates` | GET | admin only | Return seed templates (Free/Pro/Business) admin can clone |
| `/plans` | POST | admin only | Create plan from template (Stripe Product + Price + DB row, all-or-nothing) |
| `/plans/:id` | PATCH | admin only | Edit display copy, features, quotas (NOT price) |
| `/plans/:id` | DELETE | admin only | Soft-archive |
| `/me/subscription` | GET | user | Current plan, status, period end, usage, cancel state |
| `/me/subscription/intent` | POST | user | Create Stripe Customer (if needed) + SetupIntent; return `client_secret` |
| `/me/subscription` | POST | user | Create Stripe Subscription with confirmed payment method, write `BillSubscription` |
| `/me/subscription/cancel` | POST | user | Set `cancel_at_period_end = true` on Stripe + local row |
| `/me/subscription/reactivate` | POST | user | Undo cancel before period end |
| `/admin/subscriptions` | GET | admin only | Ops view: list all accounts, plans, statuses, MRR |
| `/cron/reset-quotas` | POST | cron-only | Daily roll-over of stale subscriptions' period |
| `/cron/cleanup-events` | POST | cron-only | Weekly delete of `BillEvent` rows older than 90 days |

**Authorization:** admin routes check `currentUser.email === ADMIN_EMAIL` env or role; cron routes accept `?secret=<CRON_SECRET>` header or Vercel cron signature.

**Stripe webhook:** `POST /api/v1/agentbook/stripe-webhook` — verifies signature, inserts `BillEvent` (idempotent), applies state changes, invalidates cache.

## Library API (`@naap/billing`)

```ts
// Hot-path entitlement check — < 1ms cache-hit, < 30ms cache-miss
canUseFeature(tenantId: string, feature: FeatureFlag): Promise<boolean>;

// Hot-path quota check
checkQuota(tenantId: string, dim: UsageDimension): Promise<{
  allowed: boolean;
  used: number;
  limit: number;       // -1 = unlimited
  remaining: number;   // Infinity when unlimited
}>;

// Best-effort increment after action succeeds
incrementUsage(tenantId: string, dim: UsageDimension, n?: number): Promise<void>;

// /billing page composer
getCurrentPlan(tenantId: string): Promise<{
  plan: BillPlan;
  status: SubscriptionStatus;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  usage: Record<UsageDimension, { used: number; limit: number }>;
}>;

// Webhook handler hook
invalidateAccount(accountId: string): void;

// Future-proofing indirection
resolveAccountId(tenantId: string): Promise<string>;

// Strongly-typed unions
type FeatureFlag =
  | 'telegram_bot'
  | 'tax_package_generation'
  | 'multi_user_teams';

type UsageDimension =
  | 'expenses_created'
  | 'ocr_scans'
  | 'ai_messages'
  | 'invoices_sent'
  | 'bank_connections';

type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete';
```

### Cache behavior

- One in-process `Map<accountId, CachedPlan>` per Vercel Function instance, TTL 24h
- Cache invalidates on plan-change webhook via `invalidateAccount(accountId)`
- Different Function instances may hold stale cache after a plan change — max 24h drift, never security-relevant (Stripe's own 7-day dunning grace covers worse cases)
- Cache stores the *resolved* plan with `features` and `quotas` inlined — no DB hit on hot path

### Fail-open vs fail-closed

- Hot-path **read** failures (DB blip): `canUseFeature` returns `true`, logs warning. Better to keep the product working than to wall off everyone.
- Hot-path **write** failures (`incrementUsage`): swallowed. Usage is best-effort; Stripe owns billing truth.
- Mutation routes (plan create, subscribe): fail closed — return errors so the caller knows to retry.
- Webhook: fails closed (signature wrong = reject).

## Data flows

### Flow 1: Admin creates a plan from a template

1. Admin opens `/admin/billing` → Vercel serves frontend bundle from `/cdn/plugins/agentbook-billing/`
2. Frontend: `GET /api/v1/agentbook-billing/templates` → 3 seed objects with editable defaults
3. Admin clicks "Use Pro template" → modal pre-fills $19/mo, features, quotas → tweaks → Save
4. Frontend: `POST /api/v1/agentbook-billing/plans` with edited body
5. Route handler:
   1. `stripe.products.create({ name: 'Pro', metadata: { code: 'pro' } })` → `prod_xxx`
   2. `stripe.prices.create({ product: prod_xxx, unit_amount: 1900, currency, recurring: { interval } })` → `price_yyy`
   3. `db.billPlan.create({ stripeProductId, stripePriceId, ...rest })`
6. If step 5.3 fails, archive the Stripe Product (`stripe.products.update(prod_xxx, { active: false })`) and return 500
7. Plan appears at `GET /plans` for users

### Flow 2: User subscribes (Free → Pro)

1. Maya opens `/billing` → frontend `GET /me/subscription` → renders current Free plan + usage bars + plan picker
2. Clicks "Upgrade to Pro"
3. Frontend: `POST /me/subscription/intent` → backend:
   1. `stripe.customers.create({ email, metadata: { tenantId } })` if no `stripeCustomerId` yet → save on `BillSubscription`
   2. `stripe.setupIntents.create({ customer, payment_method_types: ['card'] })` → returns `client_secret`
4. Frontend renders Stripe Payment Element with the `client_secret` in a modal
5. Maya enters card → Payment Element handles validation + 3DS → payment method attached to customer
6. Frontend: `POST /me/subscription` with `{ planId, paymentMethodId }`
7. Backend:
   1. `stripe.subscriptions.create({ customer, items: [{ price: plan.stripePriceId }], default_payment_method: paymentMethodId })`
   2. `db.billSubscription.update({ accountId: tenantId, planId, status, stripeSubscriptionId, currentPeriodStart, currentPeriodEnd })`
   3. `invalidateAccount(tenantId)`
   4. Return summary
8. Frontend reloads `/billing` showing Pro with new quotas
9. Stripe webhook fires `customer.subscription.created` + `invoice.paid` shortly after — handler upserts state (idempotent) and Stripe emails the invoice PDF

### Flow 3: Entitlement check (Telegram message arrives)

1. Maya messages `@Agentbookdev_bot` → Telegram POSTs to `/api/v1/agentbook/telegram/webhook`
2. Webhook resolves `tenantId` from `CHAT_TO_TENANT`
3. Before invoking agent brain: `if (!await canUseFeature(tenantId, 'telegram_bot')) return reply('Telegram is a Pro feature — upgrade at <link>')`
4. Inside `canUseFeature`:
   1. `accountId = await resolveAccountId(tenantId)` → today returns `tenantId`
   2. Cache hit (24h TTL) → return `true` in < 1ms
5. On cache miss: one Prisma query joining `BillSubscription` → `BillPlan`, cache, return

### Flow 4: Quota check + increment (receipt OCR)

1. Maya sends photo to bot
2. Before OCR: `const q = await checkQuota(tenantId, 'ocr_scans')`
3. If `!q.allowed`: reply `"You've used all ${q.limit} receipt scans this month — upgrade for 200/month: <link>"`
4. Else: run OCR → create expense draft → `incrementUsage(tenantId, 'ocr_scans', 1)` (best-effort)
5. If `q.used / q.limit >= 0.8`, append soft warning: `"(Heads up: ${q.used} of ${q.limit} OCR scans used.)"`

### Flow 5: Stripe webhook handles subscription update

1. Stripe POSTs to `/api/v1/agentbook/stripe-webhook` with raw body + `stripe-signature` header
2. Handler verifies signature with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` — returns 400 on mismatch
3. `INSERT INTO BillEvent (stripeEventId, eventType, payload) VALUES (...) ON CONFLICT DO NOTHING` — if `rowCount = 0`, return 200 (already processed)
4. Switch on `event.type`:
   - `customer.subscription.updated` → upsert `BillSubscription` (status, periods, planId via stripe price id lookup, `cancelAtPeriodEnd`)
   - `customer.subscription.deleted` → set `status='canceled'`, `canceledAt = now()`
   - `invoice.paid` → optionally mirror into `abInvoice` for the user's own books
   - `invoice.payment_failed` → no DB write (matching `subscription.updated` event flips status to `past_due`)
5. `invalidateAccount(accountId)`
6. `UPDATE BillEvent SET processedAt = now WHERE stripeEventId = ...`
7. Return 200

### Vercel Cron (in `vercel.ts` or `vercel.json`)

```ts
crons: [
  { path: '/api/v1/agentbook-billing/cron/reset-quotas',    schedule: '0 0 * * *' },   // daily 00:00 UTC
  { path: '/api/v1/agentbook-billing/cron/cleanup-events',  schedule: '0 3 * * 0' },   // Sun 03:00 UTC
]
```

`reset-quotas`: for every `BillSubscription` whose `currentPeriodEnd < now`, advance period using Stripe (`stripe.subscriptions.retrieve`) for paid plans, or add 1 month for Free. New period → new counter rows on first usage.

`cleanup-events`: delete `BillEvent` rows older than 90 days.

## Error handling

| Site | Failure | Response |
|---|---|---|
| Hot-path entitlement check | Prisma error | Fail open — return `true`, log warning |
| Hot-path increment | Prisma error | Swallow |
| Plan create | Stripe API fails | Roll back: archive any Stripe Product, return 502 |
| Plan create | DB write fails after Stripe success | Archive Stripe Product, return 500 |
| Subscribe | Stripe `subscriptions.create` fails | No DB write; frontend shows "Couldn't reach Stripe. Try again." |
| Subscribe | Card declined | Stripe SetupIntent surfaces error in Payment Element; user retries |
| Webhook | Signature mismatch | 400, no DB write, log headers |
| Webhook | Handler throws after `BillEvent` insert | 500; Stripe retries automatically (up to 3 days, exponential backoff). Idempotent. |
| Webhook | Plan not found in our DB | Log critical alert, leave `planId` unchanged |
| Race: two simultaneous subscribes | Stripe rejects second | Catch Stripe error, treat as success |
| Cache vs reality drift | User cancels via Stripe Dashboard | Webhook `invalidateAccount` refreshes within seconds |
| Cron failure | Vercel Cron fails | Next run picks it up; quota reset is idempotent |

## Testing

### Library tests (`packages/billing/__tests__/`)

Vitest, mocked Prisma:
- `canUseFeature`: true/false for tier × feature matrix
- `checkQuota`: `-1` (unlimited), `0`, at-limit, over-limit
- Cache: hit (no Prisma call), miss (one Prisma call), invalidation
- Fail-open: Prisma throws → returns `true`
- Status: `active`, `past_due` (allowed within grace), `canceled` (Free behavior), `incomplete` (no subscription)
- `resolveAccountId`: returns tenantId today
- Target: ~30 tests, full public API coverage

### Backend route tests (`apps/web-next/__tests__/api/v1/agentbook-billing/`)

Vitest + Stripe test mode:
- Create plan from template → Stripe Product + Price + DB row written
- Subscribe flow with `pm_card_visa` test PM
- Cancel sets `cancel_at_period_end`; reactivate clears it
- Webhook: valid event accepted, invalid rejected, duplicate idempotent
- Cron `reset-quotas` rolls stale subscription forward
- Target: ~20 tests, every route hit at least once

### End-to-end (`tests/e2e/billing.spec.ts`)

Playwright + Stripe test mode:
- Admin → /admin/billing → clone Pro template → save → verify in Stripe Dashboard via API
- User Maya → /billing → Upgrade → Payment Element → `4242 4242 4242 4242` → confirm → /billing shows Pro
- Telegram message after upgrade: `canUseFeature('telegram_bot')` returns true (no upgrade prompt)
- Quota wall: 10 receipts on Free → 11th gets upgrade prompt
- Cancel → status "Active until <date>"
- Target: 6 happy + 4 error paths; runs in nightly E2E suite

### Stripe test mode hygiene

- All Stripe API calls go through `packages/billing/src/stripe.ts` wrapper (mockable in tests)
- Wrapper reads `STRIPE_SECRET_KEY` once at module load; `sk_test_*` outside production (`VERCEL_ENV !== 'production'`); `sk_live_*` only in prod
- Cron routes accept `?test=1` in non-prod for on-demand CI invocation

## Vercel deployment specifics

| Concern | Resolution |
|---|---|
| Runtime | Fluid Compute (default Node 24); no Edge — Stripe SDK requires Node |
| Cold starts | Stripe webhook is hot via Stripe traffic; admin/user routes acceptable cold |
| Function timeout | Default 300s, far more than the 5-10s actual ceiling |
| Env vars | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` per environment via `vercel env` |
| Cron | Declared in `vercel.ts`; clamped to billable rate per Vercel quota |
| Local dev | `next dev` + `stripe listen --forward-to localhost:3000/api/v1/agentbook/stripe-webhook` |
| Preview deployments | Separate `STRIPE_WEBHOOK_SECRET` configured for the preview endpoint; allows full e2e in preview |

## Success criteria

1. **Admin onboarding**: operator creates Free + Pro + Business plans in < 10 min
2. **User subscribe latency**: click "Upgrade" to "Pro plan active" in < 90 sec including 3DS
3. **Hot-path overhead**: < 1 ms p99 on cache-hit; entitlement gates do not measurably affect Telegram bot reply latency
4. **No double-charges**: webhook idempotency + Stripe's at-least-once delivery handled correctly under load test (replay each event 5×)
5. **Failover**: with `DATABASE_URL` pointing at an unreachable replica, the Telegram bot still replies (fail-open works); admin operations fail with clear error
6. **Team billing extension**: adding `BillSeat` later requires only one library change (`resolveAccountId`) — no consumer plugin edits

## Decisions log

- 2026-05-12: Hybrid plan type (features + quotas) over feature-only — better match for Stripe metered Prices and AgentBook's real cost drivers (OCR, LLM)
- 2026-05-12: Standard 5 dimensions — covers real-dollar costs (OCR, Plaid) + product-value signals (expenses, invoices)
- 2026-05-12: Conservative gating — only 3 features tier-gated; everything else metered. Avoids punitive Free tier UX.
- 2026-05-12: Stripe Payment Element over Checkout redirect — embedded UX worth the additional ~70 lines
- 2026-05-12: Permanent Free tier — freemium funnel suits SMB accounting category
- 2026-05-12: Stripe-native branded invoices — defer custom PDFs until a customer demands them
- 2026-05-12: Vercel-native (Next.js handlers, not Express sidecar) — primary deployment target; document as future-plugin pattern
- 2026-05-12: `accountId` rename in `BillSubscription`/`BillUsageCounter`/`BillEvent` for team-billing extensibility — YAGNI rejected an explicit `accountType` enum
