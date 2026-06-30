/**
 * Accounts-payable aging — groups unpaid bills into age buckets by how far
 * past (or before) their due date they are, as of today.
 *
 *   current      — not yet due
 *   d1_30        — 1-30 days overdue
 *   d31_60       — 31-60 days overdue
 *   d60_plus     — 60+ days overdue
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { bucketFor } from '@/lib/ap-aging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const bills = await db.abBill.findMany({ where: { tenantId, status: 'open' } });
    const now = new Date();

    const buckets: Record<string, { label: string; totalCents: number; count: number }> = {
      current: { label: 'Current (not due)', totalCents: 0, count: 0 },
      d1_30: { label: '1-30 days overdue', totalCents: 0, count: 0 },
      d31_60: { label: '31-60 days overdue', totalCents: 0, count: 0 },
      d60_plus: { label: '60+ days overdue', totalCents: 0, count: 0 },
    };

    for (const b of bills) {
      const key = bucketFor(b.dueDate, now);
      buckets[key].totalCents += b.amountCents;
      buckets[key].count += 1;
    }

    const totalOwedCents = bills.reduce((s, b) => s + b.amountCents, 0);

    return NextResponse.json({
      success: true,
      data: { buckets, totalOwedCents, billCount: bills.length },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/ap-aging] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
