/**
 * Expense vendors — list (sorted by transaction count desc).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const includeDeleted = parseIncludeDeleted(request.nextUrl.searchParams);
    const vendors = await db.abVendor.findMany({
      where: withSoftDelete({ tenantId }, includeDeleted),
      orderBy: { transactionCount: 'desc' },
    });

    // QA-P3-001: the Analytics page's Top Vendors list reads vendorName/
    // totalCents/avgAmountCents, none of which AbVendor has — every row
    // showed "avg $NaN". Compute real spend per vendor from AbExpense and
    // add these as extra fields (name/transactionCount stay as-is; the
    // Vendors page reads those directly).
    const spendByVendor = await db.abExpense.groupBy({
      by: ['vendorId'],
      where: { tenantId, isPersonal: false, deletedAt: null, vendorId: { in: vendors.map((v) => v.id) } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const spendMap = new Map(spendByVendor.map((s) => [s.vendorId, s]));

    const enriched = vendors.map((v) => {
      const spend = spendMap.get(v.id);
      const totalCents = spend?._sum.amountCents ?? 0;
      const count = spend?._count._all ?? 0;
      return {
        ...v,
        vendorName: v.name,
        totalCents,
        avgAmountCents: count > 0 ? Math.round(totalCents / count) : 0,
      };
    });

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error('[agentbook-expense/vendors GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
