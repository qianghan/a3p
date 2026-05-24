/**
 * GDPR / data-rights data-export endpoint.
 *
 * Returns the authenticated tenant's user-facing data as a single JSON
 * download. The response is `application/json` with a Content-Disposition
 * suggesting a filename so the browser saves it as a file.
 *
 * What's included: all rows the agent and dashboards read. What's excluded:
 * internal system tables (idempotency keys, dead-letter queue, FX rate
 * cache, LLM provider config, skill registry) — those carry no user data.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const where = { tenantId };
  // Run all reads in parallel — the export is read-only and these don't
  // depend on each other.
  const [
    tenantConfig,
    accounts,
    journalEntries,
    journalLines,
    fiscalPeriods,
    events,
    auditEvents,
    automations,
    financialSnapshots,
    conversations,
    convThreads,
    expenses,
    expenseSplits,
    vendors,
    patterns,
    recurringRules,
    bankAccounts,
    bankTransactions,
    budgets,
    mileageEntries,
    clients,
    invoices,
    invoiceLines,
    payments,
    estimates,
    projects,
    timeEntries,
    creditNotes,
    recurringInvoices,
    taxEstimates,
    quarterlyPayments,
    deductionSuggestions,
    taxConfig,
    salesTaxCollected,
    taxFilings,
    taxSlips,
    taxPackages,
    calendarEvents,
    engagementLogs,
    tenantAccess,
    cpaNotes,
    accountantRequests,
    onboardingProgress,
    homeOfficeConfig,
    userMemories,
    savedSearches,
    voiceTranscripts,
    agentConfig,
    agentPersonality,
    telegramBot,
  ] = await Promise.all([
    db.abTenantConfig.findFirst({ where: { userId: tenantId } }),
    db.abAccount.findMany({ where }),
    db.abJournalEntry.findMany({ where }),
    db.abJournalLine.findMany({ where }),
    db.abFiscalPeriod.findMany({ where }),
    db.abEvent.findMany({ where }),
    db.abAuditEvent.findMany({ where }),
    db.abAutomation.findMany({ where }),
    db.abFinancialSnapshot.findMany({ where }),
    db.abConversation.findMany({ where }),
    db.abConvThread.findMany({ where }),
    db.abExpense.findMany({ where }),
    db.abExpenseSplit.findMany({ where }),
    db.abVendor.findMany({ where }),
    db.abPattern.findMany({ where }),
    db.abRecurringRule.findMany({ where }),
    db.abBankAccount.findMany({ where, select: { id: true, tenantId: true, institution: true, name: true, mask: true, type: true, balanceCents: true, currency: true, createdAt: true, lastSynced: true } }),
    db.abBankTransaction.findMany({ where }),
    db.abBudget.findMany({ where }),
    db.abMileageEntry.findMany({ where }),
    db.abClient.findMany({ where }),
    db.abInvoice.findMany({ where }),
    db.abInvoiceLine.findMany({ where }),
    db.abPayment.findMany({ where }),
    db.abEstimate.findMany({ where }),
    db.abProject.findMany({ where }),
    db.abTimeEntry.findMany({ where }),
    db.abCreditNote.findMany({ where }),
    db.abRecurringInvoice.findMany({ where }),
    db.abTaxEstimate.findMany({ where }),
    db.abQuarterlyPayment.findMany({ where }),
    db.abDeductionSuggestion.findMany({ where }),
    db.abTaxConfig.findFirst({ where }),
    db.abSalesTaxCollected.findMany({ where }),
    db.abTaxFiling.findMany({ where }),
    db.abTaxSlip.findMany({ where }),
    db.abTaxPackage.findMany({ where }),
    db.abCalendarEvent.findMany({ where }),
    db.abEngagementLog.findMany({ where }),
    db.abTenantAccess.findMany({ where }),
    db.abCPANote.findMany({ where }),
    db.abAccountantRequest.findMany({ where }),
    db.abOnboardingProgress.findFirst({ where }),
    db.abHomeOfficeConfig.findFirst({ where }),
    db.abUserMemory.findMany({ where }),
    db.abSavedSearch.findMany({ where }),
    db.abVoiceTranscript.findMany({ where }),
    db.abAgentConfig.findFirst({ where }),
    db.abAgentPersonality.findFirst({ where }),
    db.abTelegramBot.findFirst({ where, select: { id: true, tenantId: true, botUsername: true, chatIds: true, createdAt: true } }),
  ]);

  // Record the export in the audit trail. Best-effort — never fail the
  // export over a logging failure.
  try {
    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'account.data_exported',
        actor: 'user',
        action: { source: 'self-service' },
      },
    });
  } catch {
    /* best-effort audit */
  }

  const exportedAt = new Date().toISOString();
  const payload = {
    exportedAt,
    tenantId,
    schemaNote:
      'AgentBook self-service data export. Plaid access tokens are not included (encrypted, internal). Stripe customer IDs are returned only on the tenant config row.',
    tenantConfig,
    accounts,
    journal: { entries: journalEntries, lines: journalLines },
    fiscalPeriods,
    events,
    auditEvents,
    automations,
    financialSnapshots,
    conversations,
    convThreads,
    expenses,
    expenseSplits,
    vendors,
    patterns,
    recurringRules,
    bank: { accounts: bankAccounts, transactions: bankTransactions },
    budgets,
    mileageEntries,
    clients,
    invoices: { headers: invoices, lines: invoiceLines },
    payments,
    estimates,
    projects,
    timeEntries,
    creditNotes,
    recurringInvoices,
    tax: {
      estimates: taxEstimates,
      quarterlyPayments,
      deductionSuggestions,
      config: taxConfig,
      salesTaxCollected,
      filings: taxFilings,
      slips: taxSlips,
      packages: taxPackages,
    },
    calendarEvents,
    engagementLogs,
    tenantAccess,
    cpaNotes,
    accountantRequests,
    onboardingProgress,
    homeOfficeConfig,
    userMemories,
    savedSearches,
    voiceTranscripts,
    agentConfig,
    agentPersonality,
    telegramBot,
  };

  const filename = `agentbook-export-${tenantId}-${exportedAt.slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
