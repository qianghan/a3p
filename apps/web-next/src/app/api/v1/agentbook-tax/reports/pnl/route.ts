/**
 * Profit & Loss report — revenue and expense lines aggregated from
 * journal lines within a date range. Skips accounts with zero balance.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const startDate = parseDate(params.get('startDate'), yearStart);
    const endDate = parseDate(params.get('endDate'), new Date());

    const [revenueAccounts, expenseAccounts] = await Promise.all([
      db.abAccount.findMany({
        where: { tenantId, accountType: 'revenue', isActive: true },
        select: { id: true, code: true, name: true },
      }),
      db.abAccount.findMany({
        where: { tenantId, accountType: 'expense', isActive: true },
        select: { id: true, code: true, name: true },
      }),
    ]);

    const [revenueLines, expenseLines] = await Promise.all([
      buildLines(revenueAccounts, tenantId, startDate, endDate, true),
      buildLines(expenseAccounts, tenantId, startDate, endDate, false),
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
