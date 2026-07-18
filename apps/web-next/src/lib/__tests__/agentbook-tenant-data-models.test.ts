import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma as db } from '@naap/database';

vi.mock('server-only', () => ({}));

import { TENANT_DELETE_ORDER } from '../agentbook-tenant-data-models';

// This test requires an isolated Postgres instance reachable via
// DATABASE_URL — run against a throwaway container, never the shared
// local dev DB or production. Every field used below was verified against
// the current packages/database/prisma/schema.prisma model definitions
// (not copied blind from an earlier draft) — e.g. AbInvoiceLine uses
// `rateCents` (not `unitPriceCents`), AbInvoice requires `issuedDate`,
// AbJournalLine.accountId is a real enforced foreign key to AbAccount so a
// real AbAccount row must exist first, and AbExpense/AbExpenseSplit have no
// `category` field (the optional column is `categoryId`).

describe('TENANT_DELETE_ORDER — full-fixture deletion', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID(); // control tenant — must survive untouched

  beforeAll(async () => {
    // Seed a representative row in every FK-linked pair to prove ordering
    // is actually safe, not just individually plausible. Minimal but
    // real, for BOTH tenants:
    //   - one ledger account + journal entry + journal line
    //     (AbJournalLine.accountId is a real FK to AbAccount, and
    //     AbJournalLine.entryId is a real FK to AbJournalEntry)
    //   - one client + invoice + invoice line + credit note
    //     (AbInvoice.clientId -> AbClient and AbCreditNote.invoiceId ->
    //     AbInvoice both default to Restrict — no cascade — so this
    //     directly exercises the two hardest-to-get-wrong orderings)
    //   - one expense + split
    //   - one pay run + stub
    //   - one StartupBenefitApplication + document + decision point +
    //     audit review (proves the join-based deleteMany for the three
    //     models with no tenantId/no real FK actually works end to end)
    //   - one AbTenantConfig + AbPersonalProfile (proves the userId-keyed
    //     deleteMany implementations actually match and delete their rows)
    //   - one AbEvent
    for (const tenantId of [tenantA, tenantB]) {
      const account = await db.abAccount.create({
        data: { tenantId, code: 'seed', name: 'Seed Account', accountType: 'expense' },
      });
      const entry = await db.abJournalEntry.create({
        data: { tenantId, date: new Date(), memo: 'seed', sourceType: 'manual', sourceId: 'seed', verified: true },
      });
      await db.abJournalLine.create({
        data: { tenantId, entryId: entry.id, accountId: account.id, debitCents: 100, creditCents: 0, description: 'seed' },
      });

      const client = await db.abClient.create({ data: { tenantId, name: 'Seed Client' } });
      const invoice = await db.abInvoice.create({
        data: {
          tenantId,
          clientId: client.id,
          number: `INV-${tenantId.slice(0, 8)}`,
          amountCents: 1000,
          status: 'draft',
          issuedDate: new Date(),
          dueDate: new Date(),
        },
      });
      await db.abInvoiceLine.create({
        data: { tenantId, invoiceId: invoice.id, description: 'seed', quantity: 1, rateCents: 1000, amountCents: 1000 },
      });
      await db.abCreditNote.create({
        data: { tenantId, invoiceId: invoice.id, number: `CN-${tenantId.slice(0, 8)}`, amountCents: 100, reason: 'seed' },
      });

      const expense = await db.abExpense.create({
        data: { tenantId, amountCents: 500, categoryId: 'seed-category', date: new Date(), description: 'seed' },
      });
      await db.abExpenseSplit.create({
        data: { tenantId, expenseId: expense.id, categoryId: 'seed-category', amountCents: 500 },
      });

      const payRun = await db.abPayRun.create({ data: { tenantId, periodStart: new Date(), periodEnd: new Date() } });
      await db.abPayStub.create({
        data: {
          tenantId,
          payRunId: payRun.id,
          employeeId: 'seed-employee',
          employeeName: 'Seed Employee',
          grossCents: 100000,
          federalTaxCents: 0,
          stateTaxCents: 0,
          ficaCents: 0,
          netCents: 100000,
        },
      });

      const application = await db.startupBenefitApplication.create({
        data: { tenantId, programId: 'seed-program', status: 'recommended', draft: {} },
      });
      await db.startupBenefitDocument.create({
        data: { applicationId: application.id, docType: 'seed-doc', blobUrl: 'https://example.com/seed.pdf' },
      });
      await db.startupBenefitDecisionPoint.create({
        data: { applicationId: application.id, sequenceOrder: 1, kind: 'approval', prompt: 'seed prompt' },
      });
      await db.startupBenefitAuditReview.create({
        data: { applicationId: application.id, riskLevel: 'low', findings: [], modelVersion: 'seed-model' },
      });

      await db.abTenantConfig.create({ data: { userId: tenantId } });
      await db.abPersonalProfile.create({ data: { userId: tenantId } });

      await db.abEvent.create({
        data: { tenantId, eventType: 'account.deletion_requested', actor: 'user', action: { requestedAt: new Date().toISOString() } },
      });
    }
  });

  afterAll(async () => {
    // Cleanup control tenant's data (tenantA's should already be gone by the test itself).
    for (const step of TENANT_DELETE_ORDER) await step.deleteMany(tenantB);
  });

  // StartupBenefitDocument/DecisionPoint/AuditReview have no `tenantId` and
  // no declared Prisma `@relation` to StartupBenefitApplication (just a
  // bare `applicationId: String` column — verified against schema.prisma),
  // so there's no relation field to filter/count through. Resolve the
  // tenant's application ids directly, the same way the join-based
  // deleteMany in agentbook-tenant-data-models.ts does.
  async function countStartupChildRows(tenantId: string) {
    const applications = await db.startupBenefitApplication.findMany({ where: { tenantId }, select: { id: true } });
    const applicationIds = applications.map((a) => a.id);
    if (applicationIds.length === 0) {
      return { documents: 0, decisionPoints: 0, auditReviews: 0 };
    }
    const [documents, decisionPoints, auditReviews] = await Promise.all([
      db.startupBenefitDocument.count({ where: { applicationId: { in: applicationIds } } }),
      db.startupBenefitDecisionPoint.count({ where: { applicationId: { in: applicationIds } } }),
      db.startupBenefitAuditReview.count({ where: { applicationId: { in: applicationIds } } }),
    ]);
    return { documents, decisionPoints, auditReviews };
  }

  it('deletes every seeded row for tenantA across FK-linked pairs without a constraint error, leaving tenantB untouched', async () => {
    for (const step of TENANT_DELETE_ORDER) {
      await expect(step.deleteMany(tenantA)).resolves.not.toThrow();
    }

    const [
      journalLinesA,
      invoiceLinesA,
      creditNotesA,
      expenseSplitsA,
      payStubsA,
      startupApplicationsA,
      startupChildrenA,
      tenantConfigsA,
      personalProfilesA,
      eventsA,
    ] = await Promise.all([
      db.abJournalLine.count({ where: { tenantId: tenantA } }),
      db.abInvoiceLine.count({ where: { tenantId: tenantA } }),
      db.abCreditNote.count({ where: { tenantId: tenantA } }),
      db.abExpenseSplit.count({ where: { tenantId: tenantA } }),
      db.abPayStub.count({ where: { tenantId: tenantA } }),
      db.startupBenefitApplication.count({ where: { tenantId: tenantA } }),
      countStartupChildRows(tenantA),
      db.abTenantConfig.count({ where: { userId: tenantA } }),
      db.abPersonalProfile.count({ where: { userId: tenantA } }),
      db.abEvent.count({ where: { tenantId: tenantA } }),
    ]);
    expect(journalLinesA).toBe(0);
    expect(invoiceLinesA).toBe(0);
    expect(creditNotesA).toBe(0);
    expect(expenseSplitsA).toBe(0);
    expect(payStubsA).toBe(0);
    expect(startupApplicationsA).toBe(0);
    expect(startupChildrenA).toEqual({ documents: 0, decisionPoints: 0, auditReviews: 0 });
    expect(tenantConfigsA).toBe(0);
    expect(personalProfilesA).toBe(0);
    expect(eventsA).toBe(0);

    const [
      journalLinesB,
      invoiceLinesB,
      creditNotesB,
      expenseSplitsB,
      payStubsB,
      startupApplicationsB,
      startupChildrenB,
      tenantConfigsB,
      personalProfilesB,
      eventsB,
    ] = await Promise.all([
      db.abJournalLine.count({ where: { tenantId: tenantB } }),
      db.abInvoiceLine.count({ where: { tenantId: tenantB } }),
      db.abCreditNote.count({ where: { tenantId: tenantB } }),
      db.abExpenseSplit.count({ where: { tenantId: tenantB } }),
      db.abPayStub.count({ where: { tenantId: tenantB } }),
      db.startupBenefitApplication.count({ where: { tenantId: tenantB } }),
      countStartupChildRows(tenantB),
      db.abTenantConfig.count({ where: { userId: tenantB } }),
      db.abPersonalProfile.count({ where: { userId: tenantB } }),
      db.abEvent.count({ where: { tenantId: tenantB } }),
    ]);
    expect(journalLinesB).toBe(1);
    expect(invoiceLinesB).toBe(1);
    expect(creditNotesB).toBe(1);
    expect(expenseSplitsB).toBe(1);
    expect(payStubsB).toBe(1);
    expect(startupApplicationsB).toBe(1);
    expect(startupChildrenB).toEqual({ documents: 1, decisionPoints: 1, auditReviews: 1 });
    expect(tenantConfigsB).toBe(1);
    expect(personalProfilesB).toBe(1);
    expect(eventsB).toBe(1);
  });
});
