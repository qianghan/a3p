/**
 * Trial balance — per-account debit/credit aggregates as of a date.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const asOfParam = request.nextUrl.searchParams.get('asOfDate');
    const asOfDate = asOfParam ? new Date(asOfParam) : null;

    const accounts = await db.abAccount.findMany({
      where: { tenantId, isActive: true },
      include: {
        journalLines: {
          where: asOfDate
            ? { entry: { date: { lte: asOfDate }, tenantId } }
            : { entry: { tenantId } },
        },
      },
      orderBy: { code: 'asc' },
    });

    const trialBalance = accounts
      .map((account) => {
        const totalDebits = account.journalLines.reduce((sum, l) => sum + l.debitCents, 0);
        const totalCredits = account.journalLines.reduce((sum, l) => sum + l.creditCents, 0);
        return {
          accountId: account.id,
          code: account.code,
          name: account.name,
          accountType: account.accountType,
          totalDebits,
          totalCredits,
          balance: totalDebits - totalCredits,
        };
      })
      .filter((a) => a.totalDebits > 0 || a.totalCredits > 0);

    const sumDebits = trialBalance.reduce((s, a) => s + a.totalDebits, 0);
    const sumCredits = trialBalance.reduce((s, a) => s + a.totalCredits, 0);

    return NextResponse.json({
      success: true,
      data: {
        accounts: trialBalance,
        totalDebits: sumDebits,
        totalCredits: sumCredits,
        balanced: sumDebits === sumCredits,
        asOfDate: asOfDate?.toISOString() || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[agentbook-core/trial-balance] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
