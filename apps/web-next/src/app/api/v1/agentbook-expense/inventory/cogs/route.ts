/**
 * COGS by period: GET ?from=&to=&granularity=month|quarter (default: this
 * calendar year, by month). Net of voids and edit reversals. PR 5B.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { cogsByPeriod, inventoryEnabled } from '@/lib/inventory';
import { inventoryErrorResponse, parseDate } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const sp = request.nextUrl.searchParams;
    const y = new Date().getUTCFullYear();
    const from = parseDate(sp.get('from'), new Date(Date.UTC(y, 0, 1)));
    const to = parseDate(sp.get('to'), new Date(Date.UTC(y + 1, 0, 1)));
    if (!from || !to || to <= from) {
      return NextResponse.json({ success: false, code: 'invalid_date', error: 'invalid date range' }, { status: 400 });
    }
    const granularity = sp.get('granularity') === 'quarter' ? 'quarter' : 'month';
    const report = await cogsByPeriod(db as never, r.tenantId, { from, to, granularity });
    return NextResponse.json({
      success: true,
      data: { ...report, granularity, from, to, trackInventory: await inventoryEnabled(db as never, r.tenantId) },
    });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/cogs GET');
  }
}
