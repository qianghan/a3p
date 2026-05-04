/**
 * Bank accounts — list with transaction counts. Used by the expenses
 * page header / bank-sync widget.
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

    const accounts = await db.abBankAccount.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const enriched = await Promise.all(
      accounts.map(async (acct) => {
        const transactionCount = await db.abBankTransaction.count({
          where: { bankAccountId: acct.id },
        });
        return { ...acct, transactionCount };
      }),
    );

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error('[agentbook-expense/bank-accounts GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
