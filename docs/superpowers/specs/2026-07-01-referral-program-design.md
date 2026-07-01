# Referral Program — Design Spec

**Date:** 2026-07-01
**Status:** Approved for planning (design decisions confirmed with user)

## Goal

Let existing users invite friends with a **unique-per-user code** (same code for all their invitees). When an invitee **signs up and pays**, the referrer earns **1 free month**, capped at **12 months (1 year)**. The experience must be simple, effective, and non-invasive, with a self-serve page to track invitees + rewards and an easy-to-share, value-focused card.

Non-goals (YAGNI for v1): tiered rewards, invitee-side reward, multi-level referral, clawback on refund/chargeback (tracked as a known follow-up), custom vanity codes.

## Confirmed decisions

1. **Reward mechanic:** Stripe **customer-balance credit** — one month's price granted as account credit per paid referral; Stripe auto-applies to the next invoice. Self-caps at 12; banks credit if the referrer isn't currently subscribed.
2. **Invite UX:** a **dismissible dashboard banner** + a full **Referrals page under Personal settings**.
3. **Share card:** an **auto-generated branded PNG** (OG-image route) + one-tap copy of link & caption + native share links (X / LinkedIn / WhatsApp).

## Data model (Prisma, `plugin_agentbook_billing` schema)

```prisma
model BillReferralCode {
  id         String   @id @default(cuid())
  tenantId   String   @unique          // one code per tenant
  code       String   @unique          // e.g. "MAYA-7K2P" (uppercase, unambiguous charset)
  createdAt  DateTime @default(now())
  @@schema("plugin_agentbook_billing")
}

model BillReferral {
  id                String    @id @default(cuid())
  referrerTenantId  String                      // who invited
  code              String                       // code used (denormalized for audit)
  inviteeTenantId   String    @unique            // the new tenant (one referral per invitee)
  inviteeEmail      String?
  status            String    @default("joined") // joined | paid
  rewardMonths      Int       @default(0)        // months credited for this referral (0 or 1)
  joinedAt          DateTime  @default(now())
  paidAt            DateTime?
  creditedAt        DateTime?
  @@index([referrerTenantId])
  @@schema("plugin_agentbook_billing")
}
```

Reward accounting is derived: `monthsEarned(referrer) = sum(rewardMonths)` capped at 12. Pending (un-applied) credit for a referrer without a Stripe customer is simply the difference between earned months and months already pushed to Stripe balance; a small `creditedAt`/`rewardMonths` bookkeeping keeps Stripe and DB in sync and idempotent.

## API (Next routes under `/api/v1/agentbook-billing/referrals`)

- `GET /referrals/me` — returns `{ code, shareUrl, monthsEarned, monthsCap: 12, invitees: [{ maskedEmail, status, joinedAt, paidAt }] }`. Lazily creates the caller's `BillReferralCode` on first read. Auth: tenant.
- `GET /referrals/card/[code]` — returns a branded **PNG** (Next OG `ImageResponse`) with value props. Public (no auth) so it renders in link unfurls / can be downloaded.
- Attribution is captured at **registration**, not a dedicated endpoint (see flow).

## Flows

### Attribution (invitee)
1. Link is `…/register?ref=CODE`. The register page reads `ref`, stores it in a short-lived cookie (`ab_ref`, 30d) and prefills a hidden field.
2. On successful registration, the register/OAuth path resolves the code → creates a `BillReferral{ status: 'joined' }` linking `referrerTenantId → inviteeTenantId`. **Guards:** ignore unknown codes; block self-referral (same email domain/tenant); ignore if the invitee already has a referral row.

### Reward (referrer earns)
1. The existing **Stripe webhook** (`/api/v1/agentbook/stripe-webhook`) already processes subscription/invoice events. On the invitee's **first** successful payment (`invoice.paid` / subscription becomes active), find their `BillReferral` (status `joined`) → set `status='paid'`, `paidAt`, `rewardMonths=1`.
2. Then grant the referrer credit: if `monthsEarned(referrer) < 12`, call `stripe.customers.createBalanceTransaction(customer, { amount: -<oneMonthPriceCents>, currency, description: 'Referral reward — 1 month' })`. If the referrer has no Stripe customer yet, leave it banked (DB tracks earned months; credit is pushed when they create a customer/subscribe). Idempotent via `creditedAt`.

### Self-serve tracking (referrer)
- **Personal → Referrals** page renders `GET /referrals/me`: the code + copy button, the share card (image + copy caption + share buttons), a progress bar (`monthsEarned / 12`), and the invitee table (masked email, Joined/Paid, dates). Copy that encourages more invites when < cap; celebrates at cap.

### Entry point
- A dismissible one-line banner on the dashboard ("Invite a friend — get up to 1 year free") linking to the Referrals page. Dismissal persists per user (localStorage + a tenant pref).

## Share card content (value-focused)

Headline: *"I do my books & taxes with AgentBook."* Sub: *"AI bookkeeping that saves freelancers on tax-filing fees and hours of admin."* Three chips: **Save on tax-prep fees**, **Peace of mind at tax time**, **Real ROI — hours back**. Footer: the code + `Sign up → 1st month, we both win`. Brand: teal gradient, `agentbook` wordmark.

## UX principles

- Non-invasive: banner is dismissible and never reappears; no modals/interrupts.
- One primary action per surface (Copy link / Share).
- Honest, savings-first messaging; no dark patterns.
- Accessible: keyboard-focusable share controls, alt text on the card.

## Testing

- **Unit:** code generation (uniqueness, charset), `monthsEarned` cap logic, self-referral guard, idempotent credit.
- **E2E (prod, Playwright):** referral page renders code + card; `?ref=` attribution creates a `joined` referral on signup; simulated invitee payment (Stripe test webhook) flips to `paid` and credits the referrer; card PNG route returns `image/png`.

## Phased PR breakdown

1. **PR-1 Data + API + reward core:** models, `db push`, `GET /referrals/me`, code generation, webhook hook for `paid` + Stripe balance credit, unit tests.
2. **PR-2 Referrals settings page + dashboard banner** (frontend).
3. **PR-3 Share card** (OG PNG route + share/copy controls).
4. Attribution wiring folds into PR-1/PR-2 (register `?ref=` capture).

Each PR: self code review, prod deploy, prod e2e, merge — per the established cycle.
