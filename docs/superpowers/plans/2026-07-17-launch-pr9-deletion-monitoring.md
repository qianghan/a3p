# Launch-gap PR-9: Account Deletion Hard-Delete Job + Error Monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two independent operational gaps found in the launch-gap stability audit: (a) `DELETE /api/v1/agentbook/me` records an `account.deletion_requested` audit event promising a 30-day hard delete, but nothing ever performs it — build the job; (b) a fully-built, defensively-coded Sentry error-reporting pipe (`reportError()` in `apps/web-next/src/lib/logger.ts`) silently no-ops in production today because `@sentry/nextjs` isn't an installed dependency — install it.

**Architecture:** Two unrelated halves sharing one PR only because they're both small, operational, launch-readiness items from the same audit.
- **Half A** (deletion job): a new lib helper (`agentbook-account-hard-delete.ts`) that queries for tenants whose grace period has elapsed and deletes every tenant-scoped row across the schema in dependency-safe order, then deletes the `User` row itself (cascading the remaining platform tables) — guarded against a real, verified blast-radius risk: `Team.ownerId` cascades `onDelete: Cascade`, so deleting a user who owns a shared team would delete that team and every other member's `TeamMember` row as a side effect of *their* deletion request, not just the requester's own data. A new cron route (`cron/account-hard-delete/route.ts`) exposes it, following the exact auth/response pattern of the existing `cron/purge-deleted/route.ts`. The cron entry is **deliberately not added to `vercel.json`** as part of the normal task flow — see the mandatory Task 6 checkpoint below, since enabling this in production means real, irreversible tenant data deletion starts happening automatically.
- **Half B** (Sentry): `logger.ts`'s `getSentry()` already lazy-imports `@sentry/nextjs` only when `SENTRY_DSN` is set, and safely no-ops if the import fails — this was built defensively for exactly this day. The only missing piece is the actual `npm install`. No logic changes to `logger.ts` are needed or wanted (scope boundary: don't build new observability tooling).

**Tech Stack:** Next.js Route Handlers (`apps/web-next`), Prisma (`@naap/database`), Vercel Cron, `@sentry/nextjs`.

## Global Constraints

- **`tenantId` is always equal to `User.id`** in this codebase (confirmed directly in `apps/web-next/src/lib/agentbook-tenant.ts`'s own doc comment and `resolveAgentbookTenant`'s session path: `return user.id;`) — the hard-delete job operates on this identity directly, no separate tenant-ID-to-user-ID lookup exists or is needed.
- **Confirmed real blast-radius risk, not hypothetical:** `packages/database/prisma/schema.prisma` — `Team.owner` is `@relation("TeamOwner", fields: [ownerId], references: [id], onDelete: Cascade)` (line 211), and `TeamMember.team`/`TeamMember.user` both cascade too. This means a straightforward `prisma.user.delete({ where: { id: tenantId } })` would silently delete every team the user OWNS — including all of that team's other members' `TeamMember`, `TeamMemberPluginAccess`, and `TeamMemberPluginConfig` rows, none of which belong to the requesting user. **The job must check for owned teams with other members before deleting the `User` row**, and skip the User-row deletion (logging a warning, not throwing) when this is detected, rather than silently cascading into other users' data. This is a hard requirement, not a nice-to-have — a shared-team side effect on a stranger's data because of an unrelated user's deletion request would be a serious, hard-to-reverse correctness bug.
- **No schema changes in this plan.** The existing `AbEvent`-based request signal (`eventType: 'account.deletion_requested'`, `action.scheduledHardDeleteAt`, `action.gracePeriodDays`) already carries everything the job needs to query. Per the roadmap's own scope boundary: "don't redesign the deletion/export flow."
- **No cancellation endpoint exists today** (`GET /api/v1/agentbook/me`'s "pending" check reads for an `account.deletion_cancelled` event type that nothing in the codebase ever writes) — this plan does not add one; it is an accepted, pre-existing gap, out of scope per the roadmap ("don't redesign the deletion/export flow"). The job simply respects whatever the existing event log says today, which in practice means every `account.deletion_requested` row is currently non-cancellable through any code path.
- **The completion of a hard delete is NOT recorded as a new `AbEvent` row.** Writing a fresh `AbEvent { tenantId, eventType: 'account.deletion_completed' }` after wiping that tenant's other data would recreate a tenant-scoped record for someone whose whole point was being fully deleted — the job instead emits a structured log line via `info()` from `@/lib/logger` (not persisted per-tenant in the database), which is consistent with genuine hard deletion.
- **Do not filter by `deletedAt`/`withSoftDelete()` anywhere in this job.** The 6 soft-delete-aware models (`AbExpense`, `AbVendor`, `AbBudget`, `AbMileageEntry`, `AbClient`, `AbInvoice`) must be deleted unconditionally by `tenantId` regardless of their `deletedAt` state — a tenant being hard-deleted needs everything gone, live or already-soft-deleted. This job is a different code path from, and must not modify, the existing `purgeSoftDeleted()` cron (`agentbook-purge-deleted.ts`), which keeps running independently for every other tenant's row-level restore window.
- **Real production DB writes are the single most consequential risk in this whole plan.** All development and testing in Tasks 1–5 happens against an isolated local/CI Postgres instance (`prisma db push` to a throwaway database, per this session's established `isolated-DB verification` pattern) — never the shared local dev DB and never production. Task 6 requires **explicit user confirmation before the cron entry is added to `vercel.json` and deployed** — this is the standing "production DB actions require explicit confirmation" rule applied to what is, functionally, a production data-deletion feature going live.
- **Half B has zero interaction with Half A** — install `@sentry/nextjs` and add one test case; do not touch `reportError()`'s existing logic (already correct and already has test coverage for the "package missing" and "DSN unset" cases).

---

### Task 1: Ordered tenant-scoped deletion model list

**Files:**
- Create: `apps/web-next/src/lib/agentbook-tenant-data-models.ts`
- Test: `apps/web-next/src/lib/__tests__/agentbook-tenant-data-models.test.ts`

**Interfaces:**
- Produces: `export const TENANT_DELETE_ORDER: Array<{ name: string; deleteMany: (tenantId: string) => Promise<{ count: number }> }>` — an array of `{name, deleteMany}` tuples in an order safe to run sequentially (children/detail rows before the parent/header rows they reference), covering every Prisma model in `packages/database/prisma/schema.prisma` that has a `tenantId` field. Task 2 imports and iterates this array; no other task needs its internals beyond this shape.

**Context:** `packages/database/prisma/schema.prisma` has 95 models carrying a `tenantId` field (verified during this plan's investigation via direct grep — re-verify the exact count yourself, since new models may have landed between then and now). The existing GDPR-export route (`apps/web-next/src/app/api/v1/agentbook/me/export/route.ts`) enumerates roughly 45 of them and is a useful cross-reference, but is **not** a complete list — it predates the personal-finance, payroll, startup-benefits, and Student Success models, so do not treat it as sufficient on its own.

- [ ] **Step 1: Enumerate every `tenantId`-bearing model**

Run: `grep -n "tenantId" packages/database/prisma/schema.prisma | grep -v "^\s*//"` and cross-reference against `grep -n "^model " packages/database/prisma/schema.prisma` to get the exact current list of model names with a `tenantId` field. Do not trust a stale count from an earlier investigation — re-derive this yourself against the current schema file, since other branches may have added models since.

- [ ] **Step 2: Group and order by dependency, detail-before-header**

Within each domain, any model that has a foreign-key-style field pointing at another tenant-scoped model in the same domain (e.g. `AbJournalLine.entryId` referencing `AbJournalEntry.id`, `AbInvoiceLine.invoiceId` referencing `AbInvoice.id`, `AbPayStub.payRunId` referencing `AbPayRun.id`, `AbExpenseSplit.expenseId` referencing `AbExpense.id`) must come BEFORE that parent model in the array — Postgres will throw an FK constraint error on `deleteMany` otherwise if the FK isn't `onDelete: Cascade`, and this plan does not assume any of them are (verify by grep for `@relation` blocks on these fields; note any that already cascade — those are safe in any order, but keeping detail-before-header for all of them is simpler and uniformly correct regardless).

Use this domain grouping as your starting scaffold (from an earlier investigation pass — verify names still exist, verify ordering, add anything new, do not treat this list as exhaustive without checking the current schema yourself):

```ts
import 'server-only';
import { prisma as db } from '@naap/database';

export interface TenantDeleteStep {
  name: string;
  deleteMany: (tenantId: string) => Promise<{ count: number }>;
}

// Order matters: detail/child rows before the header/parent row they
// reference, so deleteMany never hits a dangling foreign key. Grouped by
// domain for readability; groups themselves have no ordering requirement
// relative to each other (no cross-domain FKs were found), only the
// within-group child-before-parent order matters.
export const TENANT_DELETE_ORDER: TenantDeleteStep[] = [
  // Core / agent-brain
  { name: 'AbLearningEvent', deleteMany: (tenantId) => db.abLearningEvent.deleteMany({ where: { tenantId } }) },
  { name: 'AbSkillRun', deleteMany: (tenantId) => db.abSkillRun.deleteMany({ where: { tenantId } }) },
  { name: 'AbUserMemory', deleteMany: (tenantId) => db.abUserMemory.deleteMany({ where: { tenantId } }) },
  { name: 'AbConversation', deleteMany: (tenantId) => db.abConversation.deleteMany({ where: { tenantId } }) },
  { name: 'AbConvThread', deleteMany: (tenantId) => db.abConvThread.deleteMany({ where: { tenantId } }) },
  { name: 'AbAgentSession', deleteMany: (tenantId) => db.abAgentSession.deleteMany({ where: { tenantId } }) },
  { name: 'AbAgentSkillBinding', deleteMany: (tenantId) => db.abAgentSkillBinding.deleteMany({ where: { tenantId } }) },
  { name: 'AbAgentPersonality', deleteMany: (tenantId) => db.abAgentPersonality.deleteMany({ where: { tenantId } }) },
  { name: 'AbAgentConfig', deleteMany: (tenantId) => db.abAgentConfig.deleteMany({ where: { tenantId } }) },
  { name: 'AbSavedSearch', deleteMany: (tenantId) => db.abSavedSearch.deleteMany({ where: { tenantId } }) },
  { name: 'AbVoiceTranscript', deleteMany: (tenantId) => db.abVoiceTranscript.deleteMany({ where: { tenantId } }) },
  { name: 'AbAutomation', deleteMany: (tenantId) => db.abAutomation.deleteMany({ where: { tenantId } }) },
  { name: 'AbFinancialSnapshot', deleteMany: (tenantId) => db.abFinancialSnapshot.deleteMany({ where: { tenantId } }) },
  { name: 'AbCashflowScenario', deleteMany: (tenantId) => db.abCashflowScenario.deleteMany({ where: { tenantId } }) },
  { name: 'AbOnboardingProgress', deleteMany: (tenantId) => db.abOnboardingProgress.deleteMany({ where: { tenantId } }) },
  { name: 'AbLLMProviderConfig', deleteMany: (tenantId) => db.abLLMProviderConfig.deleteMany({ where: { tenantId } }) },
  { name: 'AbIdempotencyKey', deleteMany: (tenantId) => db.abIdempotencyKey.deleteMany({ where: { tenantId } }) },
  { name: 'AbHttpIdempotencyKey', deleteMany: (tenantId) => db.abHttpIdempotencyKey.deleteMany({ where: { tenantId } }) },
  { name: 'AbWebhookDeadLetter', deleteMany: (tenantId) => db.abWebhookDeadLetter.deleteMany({ where: { tenantId } }) },
  { name: 'AbTenantAccess', deleteMany: (tenantId) => db.abTenantAccess.deleteMany({ where: { tenantId } }) },

  // Tenant/user config + backups
  { name: 'AbPersonalProfile', deleteMany: (tenantId) => db.abPersonalProfile.deleteMany({ where: { tenantId } }) },
  { name: 'AbBackup', deleteMany: (tenantId) => db.abBackup.deleteMany({ where: { tenantId } }) },

  // Communication channels
  { name: 'AbEngagementLog', deleteMany: (tenantId) => db.abEngagementLog.deleteMany({ where: { tenantId } }) },
  { name: 'AbCalendarEvent', deleteMany: (tenantId) => db.abCalendarEvent.deleteMany({ where: { tenantId } }) },
  { name: 'AbNotificationRecipient', deleteMany: (tenantId) => db.abNotificationRecipient.deleteMany({ where: { tenantId } }) },
  { name: 'AbNotificationPreference', deleteMany: (tenantId) => db.abNotificationPreference.deleteMany({ where: { tenantId } }) },
  { name: 'AbTelegramBot', deleteMany: (tenantId) => db.abTelegramBot.deleteMany({ where: { tenantId } }) },
  { name: 'AbWhatsAppLink', deleteMany: (tenantId) => db.abWhatsAppLink.deleteMany({ where: { tenantId } }) },

  // Bookkeeping — journal lines before entries, expense splits before expenses
  { name: 'AbJournalLine', deleteMany: (tenantId) => db.abJournalLine.deleteMany({ where: { tenantId } }) },
  { name: 'AbJournalEntry', deleteMany: (tenantId) => db.abJournalEntry.deleteMany({ where: { tenantId } }) },
  { name: 'AbFiscalPeriod', deleteMany: (tenantId) => db.abFiscalPeriod.deleteMany({ where: { tenantId } }) },
  { name: 'AbAccount', deleteMany: (tenantId) => db.abAccount.deleteMany({ where: { tenantId } }) },
  { name: 'AbExpenseSplit', deleteMany: (tenantId) => db.abExpenseSplit.deleteMany({ where: { tenantId } }) },
  { name: 'AbExpense', deleteMany: (tenantId) => db.abExpense.deleteMany({ where: { tenantId } }) },
  { name: 'AbPattern', deleteMany: (tenantId) => db.abPattern.deleteMany({ where: { tenantId } }) },
  { name: 'AbRecurringRule', deleteMany: (tenantId) => db.abRecurringRule.deleteMany({ where: { tenantId } }) },
  { name: 'AbBudget', deleteMany: (tenantId) => db.abBudget.deleteMany({ where: { tenantId } }) },
  { name: 'AbMileageEntry', deleteMany: (tenantId) => db.abMileageEntry.deleteMany({ where: { tenantId } }) },
  { name: 'AbVendor', deleteMany: (tenantId) => db.abVendor.deleteMany({ where: { tenantId } }) },
  { name: 'AbHomeOfficeConfig', deleteMany: (tenantId) => db.abHomeOfficeConfig.deleteMany({ where: { tenantId } }) },

  // Bank/Plaid
  { name: 'AbBankTransaction', deleteMany: (tenantId) => db.abBankTransaction.deleteMany({ where: { tenantId } }) },
  { name: 'AbBankAccount', deleteMany: (tenantId) => db.abBankAccount.deleteMany({ where: { tenantId } }) },
  { name: 'AbStripeWebhookEvent', deleteMany: (tenantId) => db.abStripeWebhookEvent.deleteMany({ where: { tenantId } }) },

  // Invoicing — lines before invoice, time entries before project
  { name: 'AbInvoiceLine', deleteMany: (tenantId) => db.abInvoiceLine.deleteMany({ where: { tenantId } }) },
  { name: 'AbPayment', deleteMany: (tenantId) => db.abPayment.deleteMany({ where: { tenantId } }) },
  { name: 'AbCreditNote', deleteMany: (tenantId) => db.abCreditNote.deleteMany({ where: { tenantId } }) },
  { name: 'AbInvoice', deleteMany: (tenantId) => db.abInvoice.deleteMany({ where: { tenantId } }) },
  { name: 'AbRecurringInvoice', deleteMany: (tenantId) => db.abRecurringInvoice.deleteMany({ where: { tenantId } }) },
  { name: 'AbDeferredRevenue', deleteMany: (tenantId) => db.abDeferredRevenue.deleteMany({ where: { tenantId } }) },
  { name: 'AbEstimate', deleteMany: (tenantId) => db.abEstimate.deleteMany({ where: { tenantId } }) },
  { name: 'AbTimeEntry', deleteMany: (tenantId) => db.abTimeEntry.deleteMany({ where: { tenantId } }) },
  { name: 'AbProject', deleteMany: (tenantId) => db.abProject.deleteMany({ where: { tenantId } }) },
  { name: 'AbBill', deleteMany: (tenantId) => db.abBill.deleteMany({ where: { tenantId } }) },
  { name: 'AbClient', deleteMany: (tenantId) => db.abClient.deleteMany({ where: { tenantId } }) },

  // Tax
  { name: 'AbDeductionSuggestion', deleteMany: (tenantId) => db.abDeductionSuggestion.deleteMany({ where: { tenantId } }) },
  { name: 'AbQuarterlyPayment', deleteMany: (tenantId) => db.abQuarterlyPayment.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxEstimate', deleteMany: (tenantId) => db.abTaxEstimate.deleteMany({ where: { tenantId } }) },
  { name: 'AbSalesTaxCollected', deleteMany: (tenantId) => db.abSalesTaxCollected.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxSlip', deleteMany: (tenantId) => db.abTaxSlip.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxFiling', deleteMany: (tenantId) => db.abTaxFiling.deleteMany({ where: { tenantId } }) },
  { name: 'AbPastTaxFiling', deleteMany: (tenantId) => db.abPastTaxFiling.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxPackage', deleteMany: (tenantId) => db.abTaxPackage.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxFastTrackDraft', deleteMany: (tenantId) => db.abTaxFastTrackDraft.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxQuestionnaireSession', deleteMany: (tenantId) => db.abTaxQuestionnaireSession.deleteMany({ where: { tenantId } }) },
  { name: 'AbTaxConfig', deleteMany: (tenantId) => db.abTaxConfig.deleteMany({ where: { tenantId } }) },

  // CPA collaboration
  { name: 'AbCPANote', deleteMany: (tenantId) => db.abCPANote.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaReviewReport', deleteMany: (tenantId) => db.abCpaReviewReport.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaReviewLink', deleteMany: (tenantId) => db.abCpaReviewLink.deleteMany({ where: { tenantId } }) },
  { name: 'AbBookSignoff', deleteMany: (tenantId) => db.abBookSignoff.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaInvite', deleteMany: (tenantId) => db.abCpaInvite.deleteMany({ where: { tenantId } }) },
  { name: 'AbAccountantRequest', deleteMany: (tenantId) => db.abAccountantRequest.deleteMany({ where: { tenantId } }) },
  { name: 'AbDocumentRequest', deleteMany: (tenantId) => db.abDocumentRequest.deleteMany({ where: { tenantId } }) },
  { name: 'StartupBenefitDocument', deleteMany: (tenantId) => db.startupBenefitDocument.deleteMany({ where: { tenantId } }) },

  // Payroll — stubs/deposits before pay run
  { name: 'AbPayStub', deleteMany: (tenantId) => db.abPayStub.deleteMany({ where: { tenantId } }) },
  { name: 'AbPayrollTaxDeposit', deleteMany: (tenantId) => db.abPayrollTaxDeposit.deleteMany({ where: { tenantId } }) },
  { name: 'AbPayRun', deleteMany: (tenantId) => db.abPayRun.deleteMany({ where: { tenantId } }) },
  { name: 'AbEmployee', deleteMany: (tenantId) => db.abEmployee.deleteMany({ where: { tenantId } }) },

  // Personal finance
  { name: 'AbPersonalTransaction', deleteMany: (tenantId) => db.abPersonalTransaction.deleteMany({ where: { tenantId } }) },
  { name: 'AbPersonalAccount', deleteMany: (tenantId) => db.abPersonalAccount.deleteMany({ where: { tenantId } }) },
  { name: 'AbPersonalBudget', deleteMany: (tenantId) => db.abPersonalBudget.deleteMany({ where: { tenantId } }) },
  { name: 'AbPersonalNudgeLog', deleteMany: (tenantId) => db.abPersonalNudgeLog.deleteMany({ where: { tenantId } }) },

  // Startup / benefits
  { name: 'StartupBenefitApplication', deleteMany: (tenantId) => db.startupBenefitApplication.deleteMany({ where: { tenantId } }) },
  { name: 'StartupBenefitEligibilityAssessment', deleteMany: (tenantId) => db.startupBenefitEligibilityAssessment.deleteMany({ where: { tenantId } }) },
  { name: 'StartupBenefitProfile', deleteMany: (tenantId) => db.startupBenefitProfile.deleteMany({ where: { tenantId } }) },

  // Student Success
  { name: 'AbStudentOpportunity', deleteMany: (tenantId) => db.abStudentOpportunity.deleteMany({ where: { tenantId } }) },
  { name: 'AbRoommateProfile', deleteMany: (tenantId) => db.abRoommateProfile.deleteMany({ where: { tenantId } }) },

  // Billing / referrals
  { name: 'SalesRepFeeRebate', deleteMany: (tenantId) => db.salesRepFeeRebate.deleteMany({ where: { tenantId } }) },
  { name: 'SalesRepApplication', deleteMany: (tenantId) => db.salesRepApplication.deleteMany({ where: { tenantId } }) },
  { name: 'SalesRepProfile', deleteMany: (tenantId) => db.salesRepProfile.deleteMany({ where: { tenantId } }) },
  { name: 'BillReferralCode', deleteMany: (tenantId) => db.billReferralCode.deleteMany({ where: { tenantId } }) },

  // Tenant config (keyed by userId, functionally == tenantId here)
  { name: 'AbTenantConfig', deleteMany: (tenantId) => db.abTenantConfig.deleteMany({ where: { userId: tenantId } }) },

  // Audit/event log LAST — deleted only after every other read of tenant
  // data this job itself might want to reference is done; nothing in this
  // job reads AbEvent/AbAuditEvent after this point.
  { name: 'AbAuditEvent', deleteMany: (tenantId) => db.abAuditEvent.deleteMany({ where: { tenantId } }) },
  { name: 'AbEvent', deleteMany: (tenantId) => db.abEvent.deleteMany({ where: { tenantId } }) },
];
```

Verify against the current schema: for every model name in `TENANT_DELETE_ORDER`, confirm the model actually exists in `packages/database/prisma/schema.prisma` with a `tenantId` field (or the correct alternate key, as noted for `AbTenantConfig`'s `userId`), and confirm every model with a `tenantId` field found in Step 1 appears somewhere in this array — add any missing model to the appropriate domain group, in FK-safe order, following the same pattern.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prisma as db } from '@naap/database';
import { TENANT_DELETE_ORDER } from '../agentbook-tenant-data-models';

// This test requires an isolated Postgres instance reachable via
// DATABASE_URL — run against a throwaway container, never the shared
// local dev DB or production. See this repo's isolated-DB verification
// pattern (bin/*, docs/superpowers/plans/*) for the bootstrap commands.

describe('TENANT_DELETE_ORDER — full-fixture deletion', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID(); // control tenant — must survive untouched

  beforeAll(async () => {
    // Seed a representative row in every FK-linked pair to prove ordering
    // is actually safe, not just individually plausible. Minimal but
    // real: one journal entry + one line, one invoice + one line, one
    // expense + one split, one pay run + one stub, for BOTH tenants.
    for (const tenantId of [tenantA, tenantB]) {
      const entry = await db.abJournalEntry.create({
        data: { tenantId, date: new Date(), memo: 'seed', sourceType: 'manual', sourceId: 'seed', verified: true },
      });
      await db.abJournalLine.create({
        data: { tenantId, entryId: entry.id, accountId: 'seed-account', debitCents: 100, creditCents: 0, description: 'seed' },
      });
      const client = await db.abClient.create({ data: { tenantId, name: 'Seed Client' } });
      const invoice = await db.abInvoice.create({
        data: { tenantId, clientId: client.id, number: `INV-${tenantId.slice(0, 8)}`, amountCents: 1000, status: 'draft', dueDate: new Date() },
      });
      await db.abInvoiceLine.create({
        data: { tenantId, invoiceId: invoice.id, description: 'seed', quantity: 1, unitPriceCents: 1000, amountCents: 1000 },
      });
      const expense = await db.abExpense.create({
        data: { tenantId, amountCents: 500, category: 'Other', date: new Date(), description: 'seed' },
      });
      await db.abExpenseSplit.create({
        data: { tenantId, expenseId: expense.id, category: 'Other', amountCents: 500 },
      });
      await db.abEvent.create({
        data: { tenantId, eventType: 'account.deletion_requested', actor: 'user', action: { requestedAt: new Date().toISOString() } },
      });
    }
  });

  afterAll(async () => {
    // Cleanup control tenant's data (tenantA's should already be gone by the test itself).
    for (const step of TENANT_DELETE_ORDER) await step.deleteMany(tenantB);
  });

  it('deletes every seeded row for tenantA across FK-linked pairs without a constraint error, leaving tenantB untouched', async () => {
    for (const step of TENANT_DELETE_ORDER) {
      await expect(step.deleteMany(tenantA)).resolves.not.toThrow();
    }

    const [journalLinesA, invoiceLinesA, expenseSplitsA, eventsA] = await Promise.all([
      db.abJournalLine.count({ where: { tenantId: tenantA } }),
      db.abInvoiceLine.count({ where: { tenantId: tenantA } }),
      db.abExpenseSplit.count({ where: { tenantId: tenantA } }),
      db.abEvent.count({ where: { tenantId: tenantA } }),
    ]);
    expect(journalLinesA).toBe(0);
    expect(invoiceLinesA).toBe(0);
    expect(expenseSplitsA).toBe(0);
    expect(eventsA).toBe(0);

    const [journalLinesB, invoiceLinesB, expenseSplitsB, eventsB] = await Promise.all([
      db.abJournalLine.count({ where: { tenantId: tenantB } }),
      db.abInvoiceLine.count({ where: { tenantId: tenantB } }),
      db.abExpenseSplit.count({ where: { tenantId: tenantB } }),
      db.abEvent.count({ where: { tenantId: tenantB } }),
    ]);
    expect(journalLinesB).toBe(1);
    expect(invoiceLinesB).toBe(1);
    expect(expenseSplitsB).toBe(1);
    expect(eventsB).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it passes, fixing ordering if any step throws an FK error**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/agentbook-tenant-data-models.test.ts`
Expected: PASS. If any `deleteMany` call throws a foreign-key constraint error, that proves an ordering mistake — move the offending model earlier in `TENANT_DELETE_ORDER` (before whatever still references it) and re-run until clean. This iterate-until-clean loop against real seeded FK pairs is the actual proof of correctness for this task, not a priori confidence.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/lib/agentbook-tenant-data-models.ts apps/web-next/src/lib/__tests__/agentbook-tenant-data-models.test.ts
git commit -m "feat(deletion): ordered tenant-scoped deletion model list"
```

---

### Task 2: Core hard-delete job

**Files:**
- Create: `apps/web-next/src/lib/agentbook-account-hard-delete.ts`
- Test: `apps/web-next/src/lib/__tests__/agentbook-account-hard-delete.test.ts`

**Interfaces:**
- Consumes: `TENANT_DELETE_ORDER` from `./agentbook-tenant-data-models` (Task 1).
- Produces: `export async function hardDeleteScheduledAccounts(now: Date = new Date(), maxTenantsPerRun = 5): Promise<HardDeleteResult>` where `HardDeleteResult = { processed: number; skippedOwnedTeam: string[]; deleted: Array<{ tenantId: string; rowsDeleted: number }>; }`. Task 3's cron route imports and calls this function.

**Context:** Query `AbEvent` for the latest deletion-lifecycle event per tenant (mirroring the exact logic already in `GET /api/v1/agentbook/me`'s route), filter to those where `eventType === 'account.deletion_requested'` and `action.scheduledHardDeleteAt <= now`, cap how many tenants one run processes (`maxTenantsPerRun`, default 5 — keeps each cron invocation well inside the 60s `maxDuration` even if a large backlog exists), and for each eligible tenant: check for owned Teams with other members (skip + record if found), delete every `TENANT_DELETE_ORDER` row for that tenant, delete the `User` row itself, and log completion via `info()` (never a new DB row).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma as db } from '@naap/database';
import { hardDeleteScheduledAccounts } from '../agentbook-account-hard-delete';

describe('hardDeleteScheduledAccounts', () => {
  it('deletes a tenant whose grace period has elapsed, including the User row', async () => {
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
    const requestedAt = new Date('2026-01-01T00:00:00Z');
    const scheduledHardDeleteAt = new Date('2026-01-31T00:00:00Z');
    await db.abEvent.create({
      data: {
        tenantId: userId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { requestedAt: requestedAt.toISOString(), scheduledHardDeleteAt: scheduledHardDeleteAt.toISOString(), gracePeriodDays: 30 },
      },
    });
    await db.abExpense.create({ data: { tenantId: userId, amountCents: 100, category: 'Other', date: new Date(), description: 'x' } });

    const now = new Date('2026-02-01T00:00:00Z'); // past scheduledHardDeleteAt
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.deleted.some((d) => d.tenantId === userId)).toBe(true);
    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await db.abExpense.count({ where: { tenantId: userId } })).toBe(0);
    expect(await db.abEvent.count({ where: { tenantId: userId } })).toBe(0);
  });

  it('does NOT touch a tenant whose grace period has not yet elapsed', async () => {
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
    await db.abEvent.create({
      data: {
        tenantId: userId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { scheduledHardDeleteAt: new Date('2026-06-01T00:00:00Z').toISOString() },
      },
    });

    const now = new Date('2026-02-01T00:00:00Z'); // before scheduledHardDeleteAt
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.deleted.some((d) => d.tenantId === userId)).toBe(false);
    expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('skips (does not delete the User row) when the tenant owns a team with other members, and records it', async () => {
    const ownerId = randomUUID();
    const otherMemberId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local` } });
    await db.user.create({ data: { id: otherMemberId, email: `${otherMemberId}@test.local` } });
    const team = await db.team.create({ data: { name: 'Shared Team', slug: `team-${ownerId.slice(0, 8)}`, ownerId } });
    await db.teamMember.create({ data: { teamId: team.id, userId: otherMemberId, role: 'member' } });
    await db.abEvent.create({
      data: {
        tenantId: ownerId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { scheduledHardDeleteAt: new Date('2026-01-01T00:00:00Z').toISOString() },
      },
    });

    const now = new Date('2026-02-01T00:00:00Z');
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.skippedOwnedTeam).toContain(ownerId);
    expect(await db.user.findUnique({ where: { id: ownerId } })).not.toBeNull();
    expect(await db.team.findUnique({ where: { id: team.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: otherMemberId } })).not.toBeNull();
  });

  it('respects maxTenantsPerRun and only processes that many eligible tenants', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      await db.user.create({ data: { id, email: `${id}@test.local` } });
      await db.abEvent.create({
        data: { tenantId: id, eventType: 'account.deletion_requested', actor: 'user', action: { scheduledHardDeleteAt: new Date('2026-01-01T00:00:00Z').toISOString() } },
      });
    }
    const result = await hardDeleteScheduledAccounts(new Date('2026-02-01T00:00:00Z'), 2);
    expect(result.processed).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/agentbook-account-hard-delete.test.ts`
Expected: FAIL with "Cannot find module '../agentbook-account-hard-delete'" or similar.

- [ ] **Step 3: Write the implementation**

```ts
import 'server-only';
import { prisma as db } from '@naap/database';
import { info, warn } from '@/lib/logger';
import { TENANT_DELETE_ORDER } from './agentbook-tenant-data-models';

export interface HardDeleteResult {
  processed: number;
  skippedOwnedTeam: string[];
  deleted: Array<{ tenantId: string; rowsDeleted: number }>;
}

interface DeletionRequestAction {
  scheduledHardDeleteAt?: string;
}

/**
 * Hard-delete every tenant whose 30-day grace period has elapsed.
 *
 * `tenantId` is always `User.id` in this codebase — see
 * agentbook-tenant.ts's own doc comment. A tenant is eligible when its
 * MOST RECENT deletion-lifecycle AbEvent is `account.deletion_requested`
 * (no `account.deletion_cancelled` producer exists anywhere in this
 * codebase today — this mirrors the exact eligibility check already used
 * by GET /api/v1/agentbook/me) and `action.scheduledHardDeleteAt <= now`.
 *
 * Team.owner cascades onDelete — deleting a User who owns a team with
 * OTHER members would delete that team and every other member's rows as
 * a side effect of an unrelated deletion request. Any such tenant is
 * skipped (not deleted) and recorded in `skippedOwnedTeam` for manual
 * follow-up, rather than silently cascading into other users' data.
 *
 * Completion is logged via the structured logger only — NOT a new
 * AbEvent row, since re-creating a tenant-scoped record for someone who
 * was just fully deleted would defeat the point of "hard delete."
 */
export async function hardDeleteScheduledAccounts(
  now: Date = new Date(),
  maxTenantsPerRun = 5,
): Promise<HardDeleteResult> {
  const candidateEvents = await db.abEvent.findMany({
    where: { eventType: { in: ['account.deletion_requested', 'account.deletion_cancelled'] } },
    orderBy: { createdAt: 'desc' },
  });

  const latestByTenant = new Map<string, (typeof candidateEvents)[number]>();
  for (const event of candidateEvents) {
    if (!latestByTenant.has(event.tenantId)) latestByTenant.set(event.tenantId, event);
  }

  const eligible: string[] = [];
  for (const [tenantId, event] of latestByTenant) {
    if (event.eventType !== 'account.deletion_requested') continue;
    const action = event.action as DeletionRequestAction | null;
    const scheduledAt = action?.scheduledHardDeleteAt ? new Date(action.scheduledHardDeleteAt) : null;
    if (scheduledAt && scheduledAt.getTime() <= now.getTime()) eligible.push(tenantId);
  }

  const toProcess = eligible.slice(0, maxTenantsPerRun);
  const result: HardDeleteResult = { processed: 0, skippedOwnedTeam: [], deleted: [] };

  for (const tenantId of toProcess) {
    const ownedTeamsWithOthers = await db.team.findMany({
      where: { ownerId: tenantId, members: { some: { userId: { not: tenantId } } } },
      select: { id: true },
    });
    if (ownedTeamsWithOthers.length > 0) {
      warn('account hard-delete skipped: tenant owns a team with other members', {
        source: 'agentbook-account-hard-delete',
        tenantId,
      });
      result.skippedOwnedTeam.push(tenantId);
      result.processed += 1;
      continue;
    }

    let rowsDeleted = 0;
    for (const step of TENANT_DELETE_ORDER) {
      const { count } = await step.deleteMany(tenantId);
      rowsDeleted += count;
    }
    await db.user.delete({ where: { id: tenantId } }).catch(() => {
      // User row may already be gone (e.g. a retried run); the tenant's
      // data is deleted either way, which is the part that matters.
    });

    info('account hard-delete completed', {
      source: 'agentbook-account-hard-delete',
      tenantId,
      rowsDeleted,
    });
    result.deleted.push({ tenantId, rowsDeleted });
    result.processed += 1;
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/agentbook-account-hard-delete.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/agentbook-account-hard-delete.ts apps/web-next/src/lib/__tests__/agentbook-account-hard-delete.test.ts
git commit -m "feat(deletion): core hard-delete job with owned-team safety guard"
```

---

### Task 3: Cron route

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/account-hard-delete/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook/cron/account-hard-delete-route.test.ts`

**Interfaces:**
- Consumes: `hardDeleteScheduledAccounts` from `@/lib/agentbook-account-hard-delete` (Task 2).

**Context:** Exact auth/response pattern copy of the existing `cron/purge-deleted/route.ts` — bearer-compare against `CRON_SECRET`, delegate to the lib function, `reportError` on failure. **Do not add this route to `vercel.json`'s `crons` array as part of this task** — that happens only after the Task 6 user-confirmation checkpoint.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const hardDeleteScheduledAccounts = vi.fn();
vi.mock('@/lib/agentbook-account-hard-delete', () => ({
  hardDeleteScheduledAccounts: (...args: unknown[]) => hardDeleteScheduledAccounts(...args),
}));

import { GET } from '@/app/api/v1/agentbook/cron/account-hard-delete/route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook/cron/account-hard-delete', { headers });
}

beforeEach(() => {
  hardDeleteScheduledAccounts.mockReset();
  delete process.env.CRON_SECRET;
});

describe('GET /api/v1/agentbook/cron/account-hard-delete', () => {
  it('returns 401 when CRON_SECRET is set and the bearer does not match', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const res = await GET(req({ authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(hardDeleteScheduledAccounts).not.toHaveBeenCalled();
  });

  it('runs the job and returns its result when the bearer matches', async () => {
    process.env.CRON_SECRET = 'right-secret';
    hardDeleteScheduledAccounts.mockResolvedValue({ processed: 2, skippedOwnedTeam: [], deleted: [] });
    const res = await GET(req({ authorization: 'Bearer right-secret' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.processed).toBe(2);
  });

  it('returns 500 with success:false when the job throws', async () => {
    process.env.CRON_SECRET = 'right-secret';
    hardDeleteScheduledAccounts.mockRejectedValue(new Error('db down'));
    const res = await GET(req({ authorization: 'Bearer right-secret' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/account-hard-delete-route.test.ts`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Daily account hard-delete cron (Launch-gap PR-9).
 *
 * Runs hardDeleteScheduledAccounts() for tenants whose 30-day
 * account-deletion grace period (started by DELETE /api/v1/agentbook/me)
 * has elapsed. Bearer-gated when CRON_SECRET is set, matching every other
 * cron route in this codebase.
 *
 * NOT registered in vercel.json's crons array yet — see the PR that
 * introduced this file for the explicit production-enablement checkpoint.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { hardDeleteScheduledAccounts } from '@/lib/agentbook-account-hard-delete';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await hardDeleteScheduledAccounts();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    void reportError('cron/account-hard-delete failed', err, { source: 'cron/account-hard-delete' });
    return NextResponse.json(
      { success: false, error: 'account hard-delete failed' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/account-hard-delete-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/account-hard-delete/route.ts apps/web-next/src/__tests__/api/v1/agentbook/cron/account-hard-delete-route.test.ts
git commit -m "feat(deletion): cron route for account hard-delete (not yet registered in vercel.json)"
```

---

### Task 4: Sentry package install + test coverage

**Files:**
- Modify: `apps/web-next/package.json` (adds `@sentry/nextjs` as a real dependency)
- Modify: `apps/web-next/src/lib/__tests__/logger.test.ts`

**Interfaces:** none new — `reportError()`'s existing signature is unchanged.

**Context:** `logger.ts`'s `getSentry()` is already fully defensive (see Global Constraints) — this task is purely: install the package, and add one test proving that once it IS installed and a DSN is set, `captureException` is actually invoked (complementing the existing "package missing" and "DSN unset" tests already in this file).

- [ ] **Step 1: Install the package**

Run: `cd apps/web-next && npm install --save @sentry/nextjs`

- [ ] **Step 2: Write the failing test**

Add to `apps/web-next/src/lib/__tests__/logger.test.ts` (read the existing file first to match its exact mocking conventions before inserting):

```ts
it('calls Sentry captureException when @sentry/nextjs is installed and SENTRY_DSN is set', async () => {
  process.env.SENTRY_DSN = 'https://fake@sentry.io/1';
  __resetSentryForTests();

  const captureException = vi.fn();
  const withScope = vi.fn((cb: (scope: { setTag: (k: string, v: string) => void }) => void) =>
    cb({ setTag: vi.fn() }),
  );
  vi.doMock('@sentry/nextjs', () => ({ captureException, withScope }));

  const err = new Error('boom');
  await reportError('something broke', err, { tenantId: 't1' });

  expect(captureException).toHaveBeenCalledWith(err);

  vi.doUnmock('@sentry/nextjs');
  __resetSentryForTests();
});
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/logger.test.ts`
Expected: initially the test may already pass if `vi.doMock` correctly intercepts the dynamic import — if it instead fails because the real `@sentry/nextjs` (freshly installed, no mock applied yet) doesn't export `captureException`/`withScope` in the shape expected in a test environment, adjust the mock to `vi.mock` (hoisted) instead of `vi.doMock`, matching whichever this repo's existing dynamic-import test mocking convention already uses elsewhere (check `agent-brain.test.ts` or similar for the established pattern with dynamically-imported optional modules). Re-run until PASS, and confirm the pre-existing "package missing"/"DSN unset" tests in the same file still pass unmodified.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/package.json apps/web-next/package-lock.json apps/web-next/src/lib/__tests__/logger.test.ts
git commit -m "feat(monitoring): install @sentry/nextjs, add installed+DSN test coverage"
```

---

### Task 5: Full verification, PR, CI, merge, and code deploy (cron NOT yet enabled)

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full affected test suites**

Run: `cd apps/web-next && npx vitest run` against an isolated test database (per this session's established pattern — never the shared local dev DB).
Expected: all new tests pass; no failures beyond the same pre-existing/unrelated pattern already established this session (confirm via a clean `origin/main` comparison before treating any failure as pre-existing).

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: no new errors in any file this branch touches.

- [ ] **Step 3: Final whole-branch review**

Dispatch a code-reviewer subagent on the most capable available model pointed at the full diff from `origin/main` to this branch's HEAD. Specifically instruct it to: (a) independently re-derive the `TENANT_DELETE_ORDER` list against the CURRENT schema and confirm no tenant-scoped model was missed and no FK-ordering violation remains (re-run Task 1's test itself, don't just read it); (b) independently re-verify the owned-team-with-other-members guard is correct by tracing the exact Prisma query and confirming it can't miss a case (e.g. what if the tenant owns a team where they are the ONLY member — should that still block deletion, or is deleting a single-member team's rows fine? Reason through this explicitly: a team with only the owner as a member has no OTHER user's data at risk, so `members: { some: { userId: { not: tenantId } } }` correctly allows that case through); (c) confirm the cron route is NOT present in `vercel.json`'s `crons` array anywhere in this diff; (d) confirm Half B (Sentry) makes no changes to `reportError()`'s existing logic beyond the one new test case.

- [ ] **Step 4: Push, open PR, wait for CI**

Push the branch, open a PR titled per this repo's conventional-commit PR-title lint (e.g. `feat(deletion): account hard-delete job + Sentry error monitoring (Launch-gap PR-9)` — verify against the lint's actual allowed-types list before opening, since an earlier PR in this session was rejected for a non-conventional title). Describe both halves, explicitly note the cron is NOT yet registered in `vercel.json` pending a separate user-confirmed enablement step, and that the Sentry DSN itself is a manual follow-up the user will supply. Wait for CI; the chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to this branch, verified against the most recently merged PR) is expected and safe to merge past once re-confirmed for this specific PR's run.

- [ ] **Step 5: Merge and deploy the code (no cron enablement yet)**

Merge normally (no `--admin`). Deploy via `vercel build --prod` + `vercel deploy --prebuilt --prod` from a fresh worktree at the merged commit — this ships the new route and lib files to production, but since the cron entry isn't in `vercel.json`, nothing runs automatically yet. No schema migration is needed for this PR.

- [ ] **Step 6: STOP — mandatory user confirmation before enabling the cron in production**

This step is the standing "production DB actions require explicit confirmation" rule applied directly: enabling this cron means real tenant accounts start getting permanently, irreversibly deleted in production on a schedule with no human in the loop per-tenant. Do NOT add the cron entry to `vercel.json` or otherwise cause this route to run on a schedule until the user has explicitly confirmed, having been shown:
- The exact eligibility query (which tenants qualify, and that today nothing can ever mark a request as cancelled).
- The full `TENANT_DELETE_ORDER` model list and confirmation it was tested against real seeded data.
- The owned-team safety guard and what it does (skip + log, not delete) when triggered.
- The proposed cron schedule and `maxTenantsPerRun` cap.
- Confirmation that Task 1–5's tests ran only against an isolated database, never production.

Only after explicit approval: add the cron entry to `vercel.json` (e.g. `{ "path": "/api/v1/agentbook/cron/account-hard-delete", "schedule": "0 5 * * *" }`, scheduled near the existing `purge-deleted` (`0 4 * * *`) and `audit-retention` (`0 3 * * 0`) jobs), commit, open a small follow-up PR for just that one-line `vercel.json` change (keeping the "enable in production" action as its own reviewable, revertible diff, separate from the code that was already merged), merge, and redeploy.
