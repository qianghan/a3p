/**
 * Personal finance snapshot — the household dashboard in one call.
 *
 *  - netWorthCents: assets − liabilities across all personal accounts
 *  - this month: income (inflows), spending (outflows), savings rate
 *  - spendByCategory: current-month outflows grouped by category
 *  - businessFlaggedCents: spend on personal accounts marked as business
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeSnapshot } from '@/lib/personal-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [accounts, monthTxns] = await Promise.all([
      db.abPersonalAccount.findMany({ where: { tenantId, archived: false } }),
      db.abPersonalTransaction.findMany({
        where: { tenantId, date: { gte: monthStart } },
        select: { amountCents: true, category: true, businessFlag: true },
      }),
    ]);

    const snapshot = computeSnapshot(accounts, monthTxns);

    return NextResponse.json({
      success: true,
      data: { ...snapshot, accountCount: accounts.length },
    });
  } catch (err) {
    console.error('[agentbook-personal/snapshot] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
