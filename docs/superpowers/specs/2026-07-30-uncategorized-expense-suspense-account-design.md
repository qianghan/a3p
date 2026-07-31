# Uncategorized expenses must reach the books — suspense account design

**Date:** 2026-07-30
**Status:** Approved
**Bug:** nightly e2e run 30566231798, phase3 "delete an expense reverses its journal entry" — expected 30100, received 27600. A newly created 2500-cent expense never appeared in the tax estimate.

## The defect

`apps/web-next/src/app/api/v1/agentbook-expense/expenses/route.ts:125` gates journal
posting on a resolved category:

```ts
if (resolvedCategoryId && !isPersonal) {
  // ...create AbJournalEntry DR category / CR cash...
}
```

When the caller passes no `categoryId` and no `AbPattern` matches the vendor,
`resolvedCategoryId` stays null and **no journal entry is posted**. The expense row
is still created with the schema default `status: "confirmed"`
(`packages/database/prisma/schema.prisma:1823`).

Net effect: the expense shows in the user's list marked confirmed, but is absent
from the P&L, the trial balance and the tax estimate. It is not in the review queue
either — `review-queue/route.ts` filters on `status: 'pending_review'`, which this
expense never gets. The user under-claims deductions with no signal anywhere.

This is the sibling of PR #395/#396. Those closed the "tenant has zero accounts"
case; this is the "chart exists but no category resolved" case.

### Why it matters more than it looks

The tax estimate reads journal lines over accounts with `accountType: 'expense'`
(`apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts:102-174`), not
`AbExpense` rows. An expense with no journal entry is invisible to it by construction.

Both high-volume no-category callers hit this exact route:

- mobile capture sends only amount + vendor (`apps/web-next/src/app/app/capture/page.tsx:113`)
- chat `expense.record` delegates to the agent brain, which executes the skill's
  HTTP endpoint — this route (`plugins/agentbook-core/backend/src/built-in-skills.ts:84`)

## Decision

Post to a **suspense account** immediately, and reclassify when the user categorizes.

The alternative considered was routing uncategorized expenses to
`status: 'pending_review'` so they surface in the review queue. Rejected because:

- it leaves the books silent about a real cash outflow — Cash is overstated, not
  just expenses understated
- it would turn every mobile capture and every chat "I spent $25 on coffee" into a
  draft requiring a second user action

A suspense account keeps both sides of the entry correct in real time; only the
classification is provisional. This is what QuickBooks does ("Uncategorized Expense").

## Design

### 1. New account: `6999 — Uncategorized Expenses`

`accountType: 'expense'`, no `taxCategory` (it is not classified to a tax line).

Code `6999` is free in every pack — us/ca top out at `6900`, au at `6700`, and
`STUDENT_ACCOUNTS` at `5600`. Added to:

- `packages/agentbook-jurisdictions/src/us/chart-of-accounts.ts`
- `packages/agentbook-jurisdictions/src/ca/chart-of-accounts.ts`
- `packages/agentbook-jurisdictions/src/au/chart-of-accounts.ts`
- `STUDENT_ACCOUNTS` in `apps/web-next/src/lib/agentbook-chart-of-accounts.ts`

It stays `isActive: true`. The tax estimate filters on `isActive`, so the account
must be active for the money to count; and showing "Uncategorized Expenses" in a
P&L breakdown is the honest presentation.

### 2. Existing tenants

`ensureChartOfAccounts` short-circuits as soon as Cash (`1000`) exists, so adding
the code to the packs reaches new tenants only. A dedicated helper in
`agentbook-chart-of-accounts.ts`:

```ts
export const UNCATEGORIZED_CODE = '6999';
export async function ensureUncategorizedAccount(tenantId: string): Promise<{ id: string }>
```

upserts by the `(tenantId, code)` compound unique and returns the account. Called
only on the uncategorized-post path, so the hot path is unchanged.

### 3. The route

Remove the `resolvedCategoryId &&` gate. When no category resolved, debit `6999`.

**`expense.categoryId` stays `null`.** This is load-bearing: the auto-categorize
watchdog (`cron/auto-categorize-watchdog/route.ts:48`), `agentbook-catch-up.ts`,
and the `Uncategorized` display in reports all key off `categoryId: null`. The
expense must still read as needing classification — only the *ledger* stops
pretending nothing happened.

Personal expenses keep posting nothing. Unchanged.

### 4. Reclassification

Extend `backfillExpenseJournalEntry` in `agentbook-expense-ledger.ts` in place
rather than adding a new function. Its contract is already "call this whenever an
expense gains a category", and both real callers get the new behaviour for free:

- `expenses/[id]/categorize/route.ts:52`
- `agentbook-auto-categorize.ts:143`

New branch: when the expense already has a journal entry whose single debit line
points at `6999`, move that line to the new category (update `accountId` and
`description`) instead of returning early.

**On mutating a posted line.** The codebase's stated rule is that journal entries
are immutable — "create a reversing entry instead". The suspense reclass is the
deliberate exception, because the cash-basis branch of the tax estimate matches
*expense-account debits whose entry also credits the cash account*
(`tax/estimate/route.ts:127`). A `DR category / CR suspense` reclass entry does not
credit cash, so under cash basis the amount would keep being attributed to
Uncategorized forever. Moving the line keeps every report correct with one write.
The code carries a comment saying exactly this.

Only a single-debit-line entry pointing at `6999` is moved. Split entries and
already-correctly-categorized entries are left alone.

### 5. Telegram-side regressions this change would otherwise introduce

The Telegram webhook does not use the shared ledger helpers — it has inline copies.
Two of them assume "uncategorized means unbooked", which stops being true:

**5a. Double-booking on confirm.** `agentbook-bot-agent.ts:1436` (`expense.confirm`)
creates a journal entry whenever `categoryId` is set, without checking
`journalEntryId`. Today an uncategorized expense has no entry, so this is the only
booking. After this change it would be the *second* entry — a double-counted
expense. Fix: skip creation when `journalEntryId` is already set.

**5b. Categorize that never reclassifies.** The webhook's own categorize handler
(`telegram/webhook/route.ts:4699`) sets `categoryId` inline and never calls the
shared helper, so the ledger would keep the amount in `6999` after the user picked
a category. Fix: call `backfillExpenseJournalEntry`.

**5c. Stale amount after correction.** `agentbook-bot-agent.ts:1601`'s
amount-correction path is gated on `ctx.active.categoryId`, so a corrected
*uncategorized* expense would leave the original amount sitting in the books. Fix:
gate on `journalEntryId` — the actual booking — rather than on the category.

### 6. Reported, not fixed

While reading 5c: that path writes both its reversal and its replacement under
`sourceType: 'expense', sourceId: <expenseId>`, which collide with each other under
the G-021 unique constraint `@@unique([tenantId, sourceType, sourceId])`
(`schema.prisma:1636`). This is live today for categorized expenses and is not
caused by this change. Out of scope; reported separately.

### 7. Deletion

`reverseExpenseJournalEntry` mirrors whatever lines the original entry has, so it
reverses a suspense entry correctly with no change.

## Testing

Route-level guards in
`apps/web-next/src/__tests__/api/v1/agentbook-expense/ledger-wiring.test.ts`
(which already guards the sibling cases):

1. A business expense with no `categoryId` and no matching pattern posts a journal
   entry debiting the `6999` account.
2. A personal expense with no category still posts nothing.
3. The created expense row keeps `categoryId: null` — it must remain visible to the
   watchdog and review flows.
4. Categorizing an expense booked to `6999` moves the debit line to the new
   category rather than creating a second entry.

Helper-level coverage in `agentbook-expense-ledger.test.ts` for the reclass branch.

**Mutation verification:** reintroduce the `resolvedCategoryId &&` gate in the route
and confirm test 1 fails. A guard that passes against the broken code is not a guard.
