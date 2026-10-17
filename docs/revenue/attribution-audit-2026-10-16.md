# P0-8 — Referral + Partner Attribution Audit (2026-10-16)

Code-level end-to-end verification of both attribution chains. Live staging
confirmation is still required (see checklist below) — no staging credentials
were available to this sprint.

## Referral chain (peer referrals): VERIFIED in code

| Hop | Location | Status |
|---|---|---|
| Referral link `/register?ref=CODE` | `getReferralSummary().shareUrl` (`src/lib/billing/referrals.ts`) | ✅ emits correct URL |
| `?ref=` capture → `ab_ref` cookie + POST body | `(auth)/register/register-form.tsx:26-35,71` | ✅ 30-day cookie |
| Email signup attribution | `lib/api/auth.ts:register()` → `recordReferralJoin(ref, user.id, email)` | ✅ |
| OAuth (Google/GitHub/MS) signup attribution | `api/v1/auth/callback/[provider]/route.ts:45,123` reads `ab_ref` cookie → `handleOAuthCallback(provider, code, ref)` → `recordReferralJoin` (auth.ts:703) | ✅ new users only |
| Attribution guards | `recordReferralJoin`: unknown code → reject; self-referral → reject; duplicate invitee → reject (unique on `inviteeTenantId`) | ✅ tested |
| Paid conversion → reward | Stripe webhook `customer.subscription.created/updated` status=active → `processInviteePaid` → flips `joined→paid`, assigns 1 reward month (12-month cap via `computeReward`), notifies referrer (`referral_thanks`) | ✅ idempotent (already-paid → no-op) |
| Credit application | `applyPendingCredits`: no Stripe customer → banked; on subscribe → Stripe customer-balance credit of one month's plan price, marked `creditedAt` (idempotent) | ✅ tested |
| Referrer dashboard | `GET /agentbook-billing/referrals/me` → masked invitee emails, statuses | ✅ |

## Partner chain (sales-rep commission): VERIFIED in code

| Hop | Location | Status |
|---|---|---|
| Rep-owned referral code | `BillReferralCode.salesRepId` set by admin (`api/v1/admin/users/[id]/sales-rep/route.ts:127`) | ✅ |
| Signup via rep code | same `recordReferralJoin` path; `processInviteePaid` flips to `paid` but SKIPS free-month rewards for rep codes | ✅ tested |
| Recurring commission | Stripe webhook `invoice.paid` → `accrueSalesRepCommission(tenantId, invoice, eventId)`: `commissionCents = round(revenue × bps/10000)`, rate locked at accrual, idempotent via unique `[salesRepId, stripeEventId]` | ✅ tested (existing suite) |
| Guards | no referral → skip; non-rep code → skip; rep inactive → skip; $0 invoice → skip | ✅ tested |
| Owner-visible ledger | `GET /api/v1/admin/sales-reps` — per-rep paid/pending payout totals + 1099-NEC $600 badge; rep payout submission via `submitSalesRepPayout` | ✅ |
| Referral-side owner view | `GET /api/v1/admin/users` aggregates referral counts + paid reward months per referrer | ✅ |

## Gaps found: none in the attribution chains.

Both chains are fully wired with guards, idempotency, and owner-visible
ledgers. The one asymmetry worth knowing: referral rewards are free *months*
(Stripe balance credits), partner rewards are *cash commission* (manual payout
via the admin ledger) — that is the intended design, not a gap.

## Staging verification checklist (owner runs)

1. Create a referral code as user A (`/settings` → Referrals).
2. As user B (fresh email): open `/register?ref=<CODE>`, complete email signup → confirm `BillReferral` row with `status='joined'`.
3. Repeat with Google OAuth signup (different email) → confirm attribution row exists.
4. Subscribe B to Pro via Stripe test mode → confirm referral flips to `paid`, A gets the `referral_thanks` notification and 1 reward month.
5. Promote user C to sales rep (admin), use C's code for user D's signup + subscription → confirm `SalesRepCommissionAccrual` row with `commissionBpsUsed` locked and correct `commissionCents` on the first AND second `invoice.paid`.
6. Confirm the admin sales-reps dashboard shows D's commission under C's pending totals.

## Tests

- New: `apps/web-next/src/lib/billing/__tests__/referral-attribution.test.ts` — 9 tests, all passing (recordReferralJoin guards ×4, processInviteePaid ×5).
- Existing: `sales-rep-commission-accrual.test.ts` — covers the partner accrual math/guards (run in CI).
