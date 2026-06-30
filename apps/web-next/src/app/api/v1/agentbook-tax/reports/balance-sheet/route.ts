/**
 * Balance sheet — assets, liabilities, equity (with retained earnings)
 * as of a date, derived from journal-line aggregates.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { sumOpenBills } from '@/lib/balance-sheet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface BsLine {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  balanceCents: number;
}

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
    const accountingBasis =
      basisParam === 'cash' || basisParam === 'accrual'
        ? basisParam
        : tenantConfig?.accountingBasis === 'cash'
          ? 'cash'
          : 'accrual';

    const accounts = await db.abAccount.findMany({
      where: { tenantId, accountType: { in: ['asset', 'liability', 'equity'] }, isActive: true },
    });

    const lines: BsLine[] = [];
    for (const acct of accounts) {
      const agg = await db.abJournalLine.aggregate({
        where: { accountId: acct.id, entry: { tenantId, date: { lte: asOfDate } } },
        _sum: { debitCents: true, creditCents: true },
      });
      const balance =
        acct.accountType === 'asset'
          ? (agg._sum.debitCents || 0) - (agg._sum.creditCents || 0)
          : (agg._sum.creditCents || 0) - (agg._sum.debitCents || 0);
      if (balance !== 0) {
        lines.push({
          accountId: acct.id,
          code: acct.code,
          name: acct.name,
          accountType: acct.accountType,
          balanceCents: balance,
        });
      }
    }

    const assets = lines.filter((l) => l.accountType === 'asset');
    const liabilities = lines.filter((l) => l.accountType === 'liability');
    const equity = lines.filter((l) => l.accountType === 'equity');

    // Accrual basis: open (unpaid) bills only hit the ledger when paid, so they
    // are otherwise missing as a liability. Recognize them as Accounts Payable
    // and reduce retained earnings by the same amount (the expense is incurred),
    // which keeps the sheet balanced. A/R needs no derivation — invoices already
    // post Dr 1100 / Cr Revenue on creation. Cash basis leaves the sheet as-is.
    let accruedPayableCents = 0;
    if (accountingBasis === 'accrual') {
      const openBills = await db.abBill.findMany({
        where: { tenantId, status: 'open', createdAt: { lte: asOfDate } },
        select: { status: true, amountCents: true },
      });
      accruedPayableCents = sumOpenBills(openBills);
      if (accruedPayableCents > 0) {
        liabilities.push({
          accountId: 'derived:accounts-payable',
          code: '2000',
          name: 'Accounts Payable (open bills)',
          accountType: 'liability',
          balanceCents: accruedPayableCents,
        });
      }
    }

    const totalAssetsCents = assets.reduce((s, l) => s + l.balanceCents, 0);
    const totalLiabilitiesCents = liabilities.reduce((s, l) => s + l.balanceCents, 0);
    const totalEquityCents = equity.reduce((s, l) => s + l.balanceCents, 0);

    const [revAccounts, expAccounts] = await Promise.all([
      db.abAccount.findMany({
        where: { tenantId, accountType: 'revenue', isActive: true },
        select: { id: true },
      }),
      db.abAccount.findMany({
        where: { tenantId, accountType: 'expense', isActive: true },
        select: { id: true },
      }),
    ]);
    const revIds = revAccounts.map((a) => a.id);
    const expIds = expAccounts.map((a) => a.id);

    const [revAgg, expAgg] = await Promise.all([
      revIds.length > 0
        ? db.abJournalLine.aggregate({
            where: { accountId: { in: revIds }, entry: { tenantId, date: { lte: asOfDate } } },
            _sum: { creditCents: true, debitCents: true },
          })
        : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
      expIds.length > 0
        ? db.abJournalLine.aggregate({
            where: { accountId: { in: expIds }, entry: { tenantId, date: { lte: asOfDate } } },
            _sum: { creditCents: true, debitCents: true },
          })
        : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
    ]);

    const retainedEarningsCents =
      ((revAgg._sum.creditCents || 0) - (revAgg._sum.debitCents || 0)) -
      ((expAgg._sum.debitCents || 0) - (expAgg._sum.creditCents || 0)) -
      // Accrued (unpaid) bills reduce retained earnings under accrual.
      accruedPayableCents;

    const totalEquityWithRetainedCents = totalEquityCents + retainedEarningsCents;

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
        assets,
        liabilities,
        equity,
        retainedEarningsCents,
        accountsPayableOpenCents: accruedPayableCents,
        totalAssetsCents,
        totalLiabilitiesCents,
        totalEquityCents: totalEquityWithRetainedCents,
        balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityWithRetainedCents,
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/balance-sheet] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
