# Personal Finance Bank Sync (Plaid) — Design

**PR-6 of the AgentBook roadmap.** Follows the two already-shipped personal-finance PRs (PR-1: manual txn/budget UI + chat write-skill parity; PR-2: net-worth trends + nudges, gated behind the `personal_insights` add-on). This PR connects a real bank account via Plaid so personal transactions/balances populate automatically, instead of only manual entry.

## Goals

1. A tenant can connect a real bank account (Plaid Link, sandbox creds `user_good`/`pass_good` for testing) to their **personal** finance area, distinct from the existing business-expense Plaid connection (`agentbook-expense`) — these are two separate integrations against two separate tenant-scoped model sets, exactly mirroring how the two plugins already keep separate account/transaction tables today.
2. Once connected, Plaid transactions land in the **same** `AbPersonalTransaction` table the manual-entry UI already reads and writes — one unified transaction list, not two lists merged client-side.
3. Reuse the existing expense-side Plaid integration's proven patterns (encryption, cursor-based sync, stuck-Link watchdog, daily cron) as closely as possible, without touching or risking the already-shipped, revenue-generating expense-side code.
4. Gate the whole feature behind the existing `personal_insights` add-on — same rationale as gating trends (PR-2): real ongoing Plaid API cost per linked item, and bank sync is a natural "insights" extension.

## Non-goals

- **No changes to `agentbook-plaid.ts`, `AbBankAccount`, or `AbBankTransaction`** (the expense-side Plaid integration). This PR adds a parallel, personal-specific implementation rather than generalizing the existing one — personal finance doesn't need the invoice/expense matcher this file also carries, and touching a file the expense plugin depends on in production is an avoidable risk for no benefit here.
- **No chat/MCP skill for "connect my bank."** Plaid Link is an iframed OAuth UI; the expense-side integration is UI-only for the same reason (its `ChatCTA` prompts the user toward the UI, it doesn't drive Link from chat). Same scope here.
- **No transaction-matching logic** (no equivalent of `agentbook-payment-matcher.ts`) — personal transactions aren't reconciled against invoices/expenses the way business bank transactions are. A synced transaction lands with a real Plaid-derived category and that's it; the user can still edit `category`/`businessFlag`/`notes` same as any manual entry.
- **No merging of Plaid-linked and manual balance semantics beyond what the expense side already tolerates.** Manual `AbPersonalTransaction` creation still nudges `AbPersonalAccount.balanceCents` incrementally; Plaid sync still resets the balance to the absolute value from `accountsGet` afterward. This exact tension already exists on the expense side (manual expense entry doesn't touch `AbBankAccount.balanceCents` at all, so there's no live analogue to conflict with there — but the same "sync wins" resolution applies once an account is linked) — not a new problem this PR needs to solve differently.

## Architecture overview

Four pieces, each mirroring an existing expense-side sibling:

1. **Schema** — extend `AbPersonalAccount` and `AbPersonalTransaction` with the Plaid-specific columns `AbBankAccount`/`AbBankTransaction` already have (minus matching-related columns, which don't apply).
2. **New lib**, `apps/web-next/src/lib/agentbook-personal-plaid.ts` — `createLinkToken`/`exchangePublicToken`/`syncTransactionsForAccount`/`disconnectAccount`/`sanitizePlaidError`, structurally identical to `agentbook-plaid.ts` with two real differences: no matcher call, and the sign convention is inverted on write (see below).
3. **Routes + cron** — `apps/web-next/src/app/api/v1/agentbook-personal/plaid/{link-token,exchange,disconnect,sync}/route.ts` (gated by the existing `personal_insights` guard) and a new `apps/web-next/src/app/api/v1/agentbook/cron/personal-plaid-sync/route.ts` (daily, bounded concurrency, mirrors `cron/plaid-sync/route.ts`'s structure).
4. **Frontend** — a "Connect bank" section added to the existing personal dashboard page (`apps/web-next/src/app/(dashboard)/personal/page.tsx`), reusing `react-plaid-link`'s `usePlaidLink` the same way `BankConnection.tsx` does, including its stuck-Link watchdog.

## The sign-convention flip (the one place this must NOT be a literal copy)

`AbBankTransaction.amount` keeps Plaid's own convention as-is: **positive = debit/outflow, negative = credit/inflow** (see `agentbook-plaid.ts`'s own comment: *"Plaid amounts: positive = outflow (debit), negative = inflow. We store the same sign convention."*).

`AbPersonalTransaction.amountCents` uses the **opposite** convention, already established by PR-1's manual-entry route and documented in its own file header: **positive = inflow/income, negative = outflow/spend**.

`agentbook-personal-plaid.ts`'s `syncTransactionsForAccount` must therefore negate Plaid's raw amount before writing: `amountCents: -Math.round(t.amount * 100)`. This is called out explicitly in the plan as a required negation, not an oversight to catch during review — the two sibling functions differ by exactly this one line's sign.

## Schema changes

```prisma
model AbPersonalAccount {
  id             String    @id @default(uuid())
  tenantId       String
  name           String
  type           String
  balanceCents   Int       @default(0)
  currency       String    @default("USD")
  isAsset        Boolean   @default(true)
  plaidAccountId String?   @unique   // was: String? (no @unique) — tightened, see migration note below
  plaidItemId    String?              // new
  accessTokenEnc String?              // new — AES-256-GCM encrypted, via the existing agentbook-bank-token.ts helper
  cursorToken    String?              // new — Plaid /transactions/sync cursor
  institution    String?              // new
  officialName   String?              // new
  subtype        String?              // new
  mask           String?              // new
  connected      Boolean   @default(true)   // new
  lastSynced     DateTime?            // new
  archived       Boolean   @default(false)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([tenantId, archived])
  @@schema("plugin_agentbook_personal")
}

model AbPersonalTransaction {
  id                 String   @id @default(uuid())
  tenantId           String
  accountId          String
  description        String
  amountCents        Int
  date               DateTime
  category           String   @default("uncategorized")
  businessFlag       Boolean  @default(false)
  notes              String?
  plaidTransactionId String?  @unique   // new
  idempotencyKey     String?  @unique   // new
  pending            Boolean  @default(false)   // new
  merchantName       String?              // new
  createdAt          DateTime @default(now())

  @@index([tenantId, date])
  @@index([tenantId, accountId])
  @@schema("plugin_agentbook_personal")
}
```

**Migration note:** `plaidAccountId` already exists on `AbPersonalAccount` as a bare `String?` with no uniqueness constraint — it was added speculatively before this PR and has never been populated (confirmed: nothing in the current codebase writes to it). Adding `@unique` to an all-`NULL` column is safe (Postgres treats multiple `NULL`s as distinct under a unique constraint, so no data migration/backfill is needed) — this is purely additive, matching this session's established "additive migration via the normal build-time `prisma db push`" pattern from every prior PR, not a manual migration step.

## `agentbook-personal-plaid.ts` — function-by-function mapping to the expense-side original

| Function | Behavior vs. `agentbook-plaid.ts`'s version |
|---|---|
| `getPlaidClient()` | Identical — reuses the same env vars (`PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`), same cached-client pattern. Could technically import the expense-side one directly since it's already generic (no model dependency) — but the plan keeps a separate copy anyway for this file's self-containedness, matching how thoroughly separated the two integrations already are elsewhere. |
| `sanitizePlaidError()` | Identical logic — copy, not import (small, self-contained, no cross-file coupling risk). |
| `createLinkToken(tenantId)` | Identical shape. |
| `exchangePublicToken(publicToken, institutionName, tenantId)` | Same upsert-by-`plaidAccountId` pattern, writes to `db.abPersonalAccount` instead of `db.abBankAccount`. Emits `abEvent` with `eventType: 'personal.account_connected'` (not `plaid.account_connected`, to keep the event log distinguishable by source). |
| `syncTransactionsForAccount(accountId)` | Same cursor-based `/transactions/sync` loop, same 10-page safety cap, same upsert-by-`plaidTransactionId`. **Sign is negated on write** (see above). Category is still taken directly from `personal_finance_category.primary` (fallback to legacy `category.join(' > ')`) — same categorization source as the expense side, since Plaid's taxonomy is reasonable for personal spending too and this PR isn't introducing a new taxonomy. **No matcher call** — `runMatcherOnTransaction` has no personal-finance equivalent; this function stops after the upsert loop + balance/cursor refresh. |
| `disconnectAccount(accountId, tenantId)` | Same best-effort `itemRemove` + clear `accessTokenEnc`/`cursorToken` + `connected: false`. Historical `AbPersonalTransaction` rows are kept, same rationale as the expense side (disconnecting shouldn't lose reconciled history). |

Reuses `apps/web-next/src/lib/agentbook-bank-token.ts` (`encryptToken`/`decryptToken`) and `apps/web-next/src/lib/plaid-sync-summary.ts` (`summarizeSyncRuns`/`SyncRun`) directly — both are already tenant/model-agnostic, no changes needed.

## Routes

All four mirror their expense-side counterparts almost line-for-line, with two differences: they call the new personal-specific lib functions, and `link-token`/`exchange`/`sync` are gated by `requirePersonalInsightsAddon` (from the already-shipped `agentbook-personal-insights/guard.ts`) instead of `safeResolveAgentbookTenant` directly — matching PR-5's exact gate-placement precedent (gate the routes that do real work; a disconnect route stays reachable regardless, so a lapsed subscriber can still remove a bank connection they no longer want linked — mirroring PR-5's "don't trap a lapsed subscriber" principle, applied here to disconnection rather than in-progress work).

- `POST /api/v1/agentbook-personal/plaid/link-token` — gated.
- `POST /api/v1/agentbook-personal/plaid/exchange` — gated.
- `POST /api/v1/agentbook-personal/plaid/disconnect` — **not** gated (same reasoning as PR-5's `/answer`/`/cancel` staying ungated).
- `POST /api/v1/agentbook-personal/plaid/sync` — gated (manual sync does real Plaid API work, same cost profile as `/exchange`).

## Cron

`apps/web-next/src/app/api/v1/agentbook/cron/personal-plaid-sync/route.ts` — same shape as `cron/plaid-sync/route.ts`: `timingSafeEqual`-based bearer auth, a local bounded-concurrency `processAll` helper (duplicated, not imported — it's ~15 lines and importing from a cron route module the way PR-5's final review flagged as an anti-pattern isn't worth avoiding here for something this small), fan-out at concurrency 5 over `AbPersonalAccount` rows where `connected: true` and `accessTokenEnc` is set, per-tenant `abEvent` audit trail (`eventType: 'personal.cron_sync_completed'`).

New `vercel.json` entry: `{ "path": "/api/v1/agentbook/cron/personal-plaid-sync", "schedule": "0 6 * * *" }` (same daily 06:00 UTC slot as the expense cron — no reason for a different cadence).

## Frontend

A new "Connect bank" section in `apps/web-next/src/app/(dashboard)/personal/page.tsx`, placed near the existing manual-accounts list. Reuses `usePlaidLink` the same way `BankConnection.tsx` does — including the 45-second stuck-Link watchdog (`window.confirm`-based recovery, since Plaid's overlay z-index sits above everything else). Linked accounts render inline with the existing manual accounts list (same list, `plaidAccountId != null` distinguishes a linked row for a small "synced" badge + last-synced timestamp + disconnect button) rather than a separate section — consistent with Goal 2's "one unified list" principle applied to accounts as well as transactions.

## Testing

- Unit tests for `agentbook-personal-plaid.ts`, mirroring `agentbook-payment-matcher.test.ts`'s density for the parts that differ from the expense side: the sign-flip specifically (a Plaid `amount: 500` outflow must land as `amountCents: -500`), the no-matcher-call behavior, and the category-fallback logic.
- Route tests mirroring the expense-side route test conventions (mock `agentbook-personal-plaid.ts`, assert gate enforcement + response shape).
- e2e: following `bank-plaid.spec.ts`'s established precedent, the true Plaid OAuth round-trip is not automated (Link UI is iframed) — `test.skip` with the same documented rationale, sandbox creds noted for manual verification. Add one deployed-endpoint-shape e2e test (mirroring `bank-backfill-complete.spec.ts`'s pattern) hitting `/plaid/sync` against a real logged-in, `personal_insights`-entitled session to assert response shape and the 402 for a non-entitled tenant.

## Deployment notes

- Schema change is purely additive (new nullable columns, `@unique` on an all-`NULL` existing column) — applies via the normal build-time `prisma db push`, no manual migration step, matching every prior PR this session's precedent.
- No billing/monetization-activation step this time — `personal_insights` already exists and is already active in production (activated during PR-2's rollout); this PR only adds new gated routes to an add-on that's already live, not a new SKU.
- New cron entry in `vercel.json` takes effect on the next deploy automatically (Vercel cron registration is deploy-time, not a separate activation step).
