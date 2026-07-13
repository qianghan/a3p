/**
 * Personal finance net-worth trend — trailing 12 monthly points, gated
 * behind the `personal_insights` add-on.
 *
 * Fetches the full account list (including archived — computeNetWorthTrend
 * itself is responsible for excluding archived accounts from every month,
 * not just recent ones) and all transactions, then reconstructs historical
 * net worth. See lib/personal-trend.ts for the reconstruction math.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { computeNetWorthTrend } from '@/lib/personal-trend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const [accounts, transactions] = await Promise.all([
      db.abPersonalAccount.findMany({ where: { tenantId } }),
      db.abPersonalTransaction.findMany({ where: { tenantId } }),
    ]);

    const trend = computeNetWorthTrend(accounts, transactions);

    return NextResponse.json({ success: true, data: trend });
  } catch (err) {
    console.error('[agentbook-personal/trend GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
