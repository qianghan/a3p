/**
 * Balance sheet — assets, liabilities, equity (with retained earnings)
 * as of a date, derived from journal-line aggregates.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeBalanceSheet, type AccountTotals } from '@/lib/balance-sheet';
import { unpaidBillWhere } from '@/lib/bill-amounts';
import { publicErrorMessage } from '@/lib/api-error';

import { cashBasisBlock } from '@/lib/cash-basis-guard';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const asOfParam = request.nextUrl.searchParams.get('asOfDate');
    const asOfDate = asOfParam ? new Date(asOfParam) : new Date();

    // Basis precedence (mirrors the P&L route): explicit ?basis= → tenant config → accrual.
    const basisParam = (request.nextUrl.searchParams.get('basis') || '').toLowerCase();
    const tenantConfig = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { accountingBasis: true },
    });
    const requestedBasis =
      basisParam === 'cash' || basisParam === 'accrual'
        ? basisParam
        : tenantConfig?.accountingBasis === 'cash'
          ? 'cash'
          : 'accrual';
    // PR 3bc.8: open at_entry bills disable cash basis → accrual + reason.
    const cashBasisDisabled = requestedBasis === 'cash' ? await cashBasisBlock(db, tenantId) : null;
    const accountingBasis: 'cash' | 'accrual' = cashBasisDisabled ? 'accrual' : requestedBasis;

    const accounts = await db.abAccount.findMany({
      where: { tenantId, accountType: { in: ['asset', 'liability', 'equity', 'revenue', 'expense'] }, isActive: true },
    });
    const totals: AccountTotals[] = [];
    for (const acct of accounts) {
      const agg = await db.abJournalLine.aggregate({
        where: { accountId: acct.id, entry: { tenantId, date: { lte: asOfDate } } },
        _sum: { debitCents: true, creditCents: true },
      });
      totals.push({
        accountId: acct.id, code: acct.code, name: acct.name, accountType: acct.accountType,
        debitCents: agg._sum.debitCents || 0, creditCents: agg._sum.creditCents || 0,
      });
    }

    // Accrual: unpaid (open|partial, live) bills. Only at_payment rows are
    // derived as A/P (+ retained-earnings offset); at_entry rows are already
    // in journal 2000 dated by billDate — see lib/balance-sheet.ts.
    const openBills = accountingBasis === 'accrual'
      ? await db.abBill.findMany({
          where: { tenantId, ...unpaidBillWhere(), createdAt: { lte: asOfDate } },
          select: { status: true, amountCents: true, paidCents: true, postingMode: true, deletedAt: true },
        })
      : [];
    const sheet = computeBalanceSheet(totals, openBills, accountingBasis);
    const { assets, liabilities, equity, retainedEarningsCents, totalAssetsCents, totalLiabilitiesCents } = sheet;
    const accruedPayableCents = sheet.accountsPayableOpenCents;
    const totalEquityWithRetainedCents = sheet.totalEquityCents;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'report.balance_sheet.generated',
        actor: 'agent',
        action: {
          asOfDate: asOfDate.toISOString(),
          totalAssetsCents,
          totalLiabilitiesCents,
          totalEquityCents: totalEquityWithRetainedCents,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        asOfDate: asOfDate.toISOString(),
        accountingBasis,
        ...(cashBasisDisabled ? { cashBasisDisabled } : {}),
        assets,
        liabilities,
        equity,
        retainedEarningsCents,
        accountsPayableOpenCents: accruedPayableCents,
        totalAssetsCents,
        totalLiabilitiesCents,
        totalEquityCents: totalEquityWithRetainedCents,
        balanced: sheet.balanced,
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/balance-sheet] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
