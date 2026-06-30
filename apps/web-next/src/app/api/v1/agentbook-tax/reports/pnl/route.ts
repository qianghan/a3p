/**
 * Profit & Loss report.
 *
 * Two recognition bases (the books are kept on a single accrual ledger;
 * cash-basis figures are *derived*, never a second ledger):
 *
 *  - accrual (default): revenue and expenses aggregated from journal lines
 *    by entry date — revenue is recognized when invoiced. Unchanged from the
 *    original behavior, so existing reports are byte-for-byte identical.
 *  - cash: revenue is recognized when payment is received (AbPayment by
 *    date); expenses are recognized when cash actually leaves (expense-account
 *    debits whose journal entry also credits the cash account 1000). Unpaid
 *    bills (AP) therefore don't hit the cash P&L until they're paid.
 *
 * Basis precedence: explicit ?basis= query param → tenant config → accrual.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function parseDate(val: string | null, fallback: Date): Date {
  if (!val) return fallback;
  const d = new Date(val);
  return isNaN(d.getTime()) ? fallback : d;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
}

interface PnlLine {
  accountId: string;
  code: string;
  name: string;
  amountCents: number;
}

async function buildLines(
  accounts: AccountRow[],
  tenantId: string,
  startDate: Date,
  endDate: Date,
  isRevenue: boolean,
): Promise<PnlLine[]> {
  const lines: PnlLine[] = [];
  for (const acct of accounts) {
    const agg = await db.abJournalLine.aggregate({
      where: {
        accountId: acct.id,
        entry: { tenantId, date: { gte: startDate, lte: endDate } },
      },
      _sum: { debitCents: true, creditCents: true },
    });
    const amount = isRevenue
      ? (agg._sum.creditCents || 0) - (agg._sum.debitCents || 0)
      : (agg._sum.debitCents || 0) - (agg._sum.creditCents || 0);
    if (amount !== 0) {
      lines.push({ accountId: acct.id, code: acct.code, name: acct.name, amountCents: amount });
    }
  }
  return lines;
}

/** Cash-basis revenue: customer payments received within the period. */
async function buildCashRevenue(
  tenantId: string,
  startDate: Date,
  endDate: Date,
): Promise<PnlLine[]> {
  const agg = await db.abPayment.aggregate({
    where: { tenantId, date: { gte: startDate, lte: endDate } },
    _sum: { amountCents: true },
  });
  const received = agg._sum.amountCents || 0;
  if (received === 0) return [];
  return [{ accountId: 'cash-receipts', code: '4000', name: 'Cash receipts', amountCents: received }];
}

/**
 * Cash-basis expenses: expense-account debits whose journal entry also has a
 * credit to the cash account (1000) — i.e. cash that actually left in the
 * period. Excludes accrued bills (Cr Accounts Payable) until they're paid.
 */
async function buildCashExpenses(
  accounts: AccountRow[],
  tenantId: string,
  startDate: Date,
  endDate: Date,
  cashAccountId: string | null,
): Promise<PnlLine[]> {
  if (!cashAccountId) {
    // No cash account configured — fall back to accrual expense view.
    return buildLines(accounts, tenantId, startDate, endDate, false);
  }
  const lines: PnlLine[] = [];
  for (const acct of accounts) {
    const debitLines = await db.abJournalLine.findMany({
      where: {
        accountId: acct.id,
        entry: {
          tenantId,
          date: { gte: startDate, lte: endDate },
          lines: { some: { accountId: cashAccountId, creditCents: { gt: 0 } } },
        },
      },
      select: { debitCents: true, creditCents: true },
    });
    const amount = debitLines.reduce((s, l) => s + (l.debitCents - l.creditCents), 0);
    if (amount !== 0) {
      lines.push({ accountId: acct.id, code: acct.code, name: acct.name, amountCents: amount });
    }
  }
  return lines;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const startDate = parseDate(params.get('startDate'), yearStart);
    const endDate = parseDate(params.get('endDate'), new Date());

    // Basis: explicit param wins, else tenant config, else accrual.
    const basisParam = params.get('basis');
    let basis: 'cash' | 'accrual';
    if (basisParam === 'cash' || basisParam === 'accrual') {
      basis = basisParam;
    } else {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { accountingBasis: true },
      });
      basis = cfg?.accountingBasis === 'cash' ? 'cash' : 'accrual';
    }

    const [revenueAccounts, expenseAccounts, cashAccount] = await Promise.all([
      db.abAccount.findMany({
        where: { tenantId, accountType: 'revenue', isActive: true },
        select: { id: true, code: true, name: true },
      }),
      db.abAccount.findMany({
        where: { tenantId, accountType: 'expense', isActive: true },
        select: { id: true, code: true, name: true },
      }),
      db.abAccount.findFirst({ where: { tenantId, code: '1000' }, select: { id: true } }),
    ]);

    const [revenueLines, expenseLines] = await Promise.all([
      basis === 'cash'
        ? buildCashRevenue(tenantId, startDate, endDate)
        : buildLines(revenueAccounts, tenantId, startDate, endDate, true),
      basis === 'cash'
        ? buildCashExpenses(expenseAccounts, tenantId, startDate, endDate, cashAccount?.id ?? null)
        : buildLines(expenseAccounts, tenantId, startDate, endDate, false),
    ]);

    const grossRevenueCents = revenueLines.reduce((s, l) => s + l.amountCents, 0);
    const totalExpensesCents = expenseLines.reduce((s, l) => s + l.amountCents, 0);
    const netIncomeCents = grossRevenueCents - totalExpensesCents;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'report.pnl.generated',
        actor: 'agent',
        action: {
          basis,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          grossRevenueCents,
          totalExpensesCents,
          netIncomeCents,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        basis,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        revenue: revenueLines,
        expenses: expenseLines,
        grossRevenueCents,
        totalExpensesCents,
        netIncomeCents,
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/pnl] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
