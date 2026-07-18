import 'server-only';
import { prisma as db } from '@naap/database';

export interface TenantDeleteStep {
  name: string;
  deleteMany: (tenantId: string) => Promise<{ count: number }>;
}

// ----------------------------------------------------------------------------
// How this list was derived (Launch-gap PR-9, Task 1)
// ----------------------------------------------------------------------------
// Every model in packages/database/prisma/schema.prisma with a literal
// `tenantId` field was found via:
//   grep -n "tenantId" packages/database/prisma/schema.prisma | grep -v "^\s*//"
// cross-referenced against `grep -n "^model "`. That produced 91 models.
//
// Two additional models are tenant-scoped but partition on a differently
// named key instead of `tenantId` (verified individually against the
// current schema and against their call sites elsewhere in the repo):
//   - AbTenantConfig.userId    (`@unique`, set to the tenant id at creation —
//     see apps/web-next/src/app/api/v1/agentbook-core/personal-profile/route.ts
//     for the sibling model's identical pattern)
//   - AbPersonalProfile.userId (same pattern — `db.abPersonalProfile.create({
//     data: { userId: tenantId } })` in personal-profile/route.ts and
//     plugins/agentbook-core/backend/src/personal-profile-context.ts)
// That brings the total to 93 directly tenant-keyed models, all present
// below.
//
// A third category — StartupBenefitDocument, StartupBenefitDecisionPoint,
// and StartupBenefitAuditReview — has NEITHER a `tenantId` field NOR a real
// database foreign key to a tenant-scoped parent. Each only carries a plain
// `applicationId: String` column (no `@relation` declared in schema.prisma)
// pointing at StartupBenefitApplication.id, which IS tenant-scoped. Because
// there's no `@relation`, Postgres never gets an FK constraint for these
// three tables — deleting StartupBenefitApplication rows would silently
// leave these as permanently orphaned tenant data (a genuine account-
// deletion / privacy-law gap, not just an FK-crash risk). They're included
// below with a join-based deleteMany that resolves the tenant's
// StartupBenefitApplication ids first, ordered before StartupBenefitApplication
// itself (children before the parent id lookup needs to still find them).
//
// Ordering rule applied throughout: within a domain group, any model with a
// foreign-key-style field pointing at another tenant-scoped model in this
// list is placed BEFORE that parent. Verified every `@relation` block in
// schema.prisma between two models in this list:
//   - AbJournalLine.entryId -> AbJournalEntry        onDelete: Cascade (safe either order)
//   - AbJournalLine.accountId -> AbAccount            NO onDelete (default Restrict) — AbJournalLine MUST precede AbAccount
//   - AbInvoiceLine.invoiceId -> AbInvoice            onDelete: Cascade (safe either order)
//   - AbPayment.invoiceId -> AbInvoice (optional)      NO onDelete (default SetNull, optional FK) — safe either order
//   - AbCreditNote.invoiceId -> AbInvoice              NO onDelete (default Restrict) — AbCreditNote MUST precede AbInvoice
//   - AbInvoice.clientId -> AbClient                   NO onDelete (default Restrict) — AbInvoice MUST precede AbClient
//   - AbEstimate.clientId -> AbClient                  NO onDelete (default Restrict) — AbEstimate MUST precede AbClient
//   - AbTimeEntry.projectId -> AbProject (optional)     NO onDelete (default SetNull, optional FK) — safe either order
//   - AbExpense.vendorId -> AbVendor (optional)         NO onDelete (default SetNull, optional FK) — safe either order
//   - AbBankTransaction.bankAccountId -> AbBankAccount onDelete: Cascade (safe either order)
//   - AbPayStub.payRunId -> AbPayRun                   onDelete: Cascade (safe either order)
// Every other same-domain "foreign-key-shaped" field found (e.g.
// AbExpenseSplit.expenseId, AbDeferredRevenue.invoiceId,
// AbRecurringInvoice.clientId, AbDeductionSuggestion.expenseId,
// AbSalesTaxCollected.invoiceId, AbPersonalTransaction.accountId,
// AbDocumentRequest.expenseId, AbRecurringRule.vendorId, AbMileageEntry.clientId,
// AbTimeEntry.clientId/invoiceId, AbExpense.clientId) is a plain scalar column
// with no `@relation` declared at all in schema.prisma — no DB-level FK
// exists, so there is no ordering requirement for these, though
// detail-before-header is kept throughout anyway for readability and
// because both sides always carry their own tenantId and get deleted in the
// same run regardless of order.
//
// Two non-tenant-scoped models cascade FROM a tenant-scoped model and need
// no separate step here (deleting the parent tenant-scoped row cascades
// them away automatically):
//   - AbCpaComment.linkId -> AbCpaReviewLink            onDelete: Cascade
//   - AbStudentDecisionPoint.opportunityId -> AbStudentOpportunity onDelete: Cascade
//
// Groups have no ordering requirement relative to each other — no
// cross-domain FKs were found between any two models in this list.
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
  // Nullable tenantId (null rows = built-in/shared skills, never touched by
  // a tenantId-scoped deleteMany); only tenant-customized skill rows match.
  { name: 'AbSkillManifest', deleteMany: (tenantId) => db.abSkillManifest.deleteMany({ where: { tenantId } }) },
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

  // Tenant/user config + backups (userId is the tenant partition key here,
  // not tenantId — see header comment)
  { name: 'AbPersonalProfile', deleteMany: (tenantId) => db.abPersonalProfile.deleteMany({ where: { userId: tenantId } }) },
  { name: 'AbBackup', deleteMany: (tenantId) => db.abBackup.deleteMany({ where: { tenantId } }) },

  // Communication channels
  { name: 'AbEngagementLog', deleteMany: (tenantId) => db.abEngagementLog.deleteMany({ where: { tenantId } }) },
  { name: 'AbCalendarEvent', deleteMany: (tenantId) => db.abCalendarEvent.deleteMany({ where: { tenantId } }) },
  { name: 'AbNotificationRecipient', deleteMany: (tenantId) => db.abNotificationRecipient.deleteMany({ where: { tenantId } }) },
  { name: 'AbNotificationPreference', deleteMany: (tenantId) => db.abNotificationPreference.deleteMany({ where: { tenantId } }) },
  { name: 'AbTelegramBot', deleteMany: (tenantId) => db.abTelegramBot.deleteMany({ where: { tenantId } }) },
  { name: 'AbWhatsAppLink', deleteMany: (tenantId) => db.abWhatsAppLink.deleteMany({ where: { tenantId } }) },

  // Bookkeeping — journal lines before entries, expense splits before
  // expenses. AbJournalLine.accountId -> AbAccount has NO cascade/SetNull
  // (default Restrict), so AbJournalLine must precede AbAccount here.
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

  // Invoicing — lines/payments/credit-notes before invoice, time entries
  // before project, invoice/estimate before client. AbCreditNote.invoiceId
  // and AbInvoice.clientId/AbEstimate.clientId all default to Restrict (no
  // onDelete declared), so those child rows MUST be deleted first.
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

  // CPA collaboration (AbCpaComment cascades automatically from
  // AbCpaReviewLink deletion — see header comment — so it needs no step)
  { name: 'AbCPANote', deleteMany: (tenantId) => db.abCPANote.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaReviewReport', deleteMany: (tenantId) => db.abCpaReviewReport.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaReviewLink', deleteMany: (tenantId) => db.abCpaReviewLink.deleteMany({ where: { tenantId } }) },
  { name: 'AbBookSignoff', deleteMany: (tenantId) => db.abBookSignoff.deleteMany({ where: { tenantId } }) },
  { name: 'AbCpaInvite', deleteMany: (tenantId) => db.abCpaInvite.deleteMany({ where: { tenantId } }) },
  { name: 'AbAccountantRequest', deleteMany: (tenantId) => db.abAccountantRequest.deleteMany({ where: { tenantId } }) },
  { name: 'AbDocumentRequest', deleteMany: (tenantId) => db.abDocumentRequest.deleteMany({ where: { tenantId } }) },

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

  // Startup / benefits. StartupBenefitDocument, StartupBenefitDecisionPoint,
  // and StartupBenefitAuditReview have NO tenantId field and NO declared
  // `@relation`/FK to StartupBenefitApplication (verified directly against
  // schema.prisma — each is a bare `applicationId: String` column) — see
  // the header comment. They must be resolved via applicationId and MUST
  // run before StartupBenefitApplication itself, or the lookup below would
  // find zero application ids to join against.
  {
    name: 'StartupBenefitDocument',
    deleteMany: async (tenantId) => {
      const applicationIds = await tenantStartupBenefitApplicationIds(tenantId);
      if (applicationIds.length === 0) return { count: 0 };
      return db.startupBenefitDocument.deleteMany({ where: { applicationId: { in: applicationIds } } });
    },
  },
  {
    name: 'StartupBenefitDecisionPoint',
    deleteMany: async (tenantId) => {
      const applicationIds = await tenantStartupBenefitApplicationIds(tenantId);
      if (applicationIds.length === 0) return { count: 0 };
      return db.startupBenefitDecisionPoint.deleteMany({ where: { applicationId: { in: applicationIds } } });
    },
  },
  {
    name: 'StartupBenefitAuditReview',
    deleteMany: async (tenantId) => {
      const applicationIds = await tenantStartupBenefitApplicationIds(tenantId);
      if (applicationIds.length === 0) return { count: 0 };
      return db.startupBenefitAuditReview.deleteMany({ where: { applicationId: { in: applicationIds } } });
    },
  },
  { name: 'StartupBenefitApplication', deleteMany: (tenantId) => db.startupBenefitApplication.deleteMany({ where: { tenantId } }) },
  { name: 'StartupBenefitEligibilityAssessment', deleteMany: (tenantId) => db.startupBenefitEligibilityAssessment.deleteMany({ where: { tenantId } }) },
  { name: 'StartupBenefitProfile', deleteMany: (tenantId) => db.startupBenefitProfile.deleteMany({ where: { tenantId } }) },

  // Student Success (AbStudentDecisionPoint cascades automatically from
  // AbStudentOpportunity deletion — see header comment — so it needs no step)
  { name: 'AbStudentOpportunity', deleteMany: (tenantId) => db.abStudentOpportunity.deleteMany({ where: { tenantId } }) },
  { name: 'AbRoommateProfile', deleteMany: (tenantId) => db.abRoommateProfile.deleteMany({ where: { tenantId } }) },

  // Billing / referrals
  { name: 'SalesRepFeeRebate', deleteMany: (tenantId) => db.salesRepFeeRebate.deleteMany({ where: { tenantId } }) },
  { name: 'SalesRepApplication', deleteMany: (tenantId) => db.salesRepApplication.deleteMany({ where: { tenantId } }) },
  { name: 'SalesRepProfile', deleteMany: (tenantId) => db.salesRepProfile.deleteMany({ where: { tenantId } }) },
  { name: 'BillReferralCode', deleteMany: (tenantId) => db.billReferralCode.deleteMany({ where: { tenantId } }) },
  //
  // DELIBERATELY EXCLUDED from hard-delete (retained for record-keeping):
  // BillSubscription, BillUsageCounter, BillEvent, BillAddOnSubscription,
  // BillReferral, SalesRepContract, SalesRepCommissionAccrual, SalesRepPayout.
  // These models hold financial/tax/chargeback-dispute records that must be
  // retained even after account deletion (standard legal/tax/payment-processor
  // requirements for record retention). They partition on accountId/salesRepId/
  // referrerTenantId instead of tenantId, making them logically associated with
  // the account but not functionally scoped by it. This exclusion is an explicit,
  // confirmed product policy decision (not an oversight) — see PR #9, Task 1.

  // Tenant config (keyed by userId, functionally == tenantId here — see
  // header comment)
  { name: 'AbTenantConfig', deleteMany: (tenantId) => db.abTenantConfig.deleteMany({ where: { userId: tenantId } }) },

  // Audit/event log LAST — deleted only after every other read of tenant
  // data this job itself might want to reference is done; nothing in this
  // job reads AbEvent/AbAuditEvent after this point.
  { name: 'AbAuditEvent', deleteMany: (tenantId) => db.abAuditEvent.deleteMany({ where: { tenantId } }) },
  { name: 'AbEvent', deleteMany: (tenantId) => db.abEvent.deleteMany({ where: { tenantId } }) },
];

async function tenantStartupBenefitApplicationIds(tenantId: string): Promise<string[]> {
  const applications = await db.startupBenefitApplication.findMany({
    where: { tenantId },
    select: { id: true },
  });
  return applications.map((application) => application.id);
}
