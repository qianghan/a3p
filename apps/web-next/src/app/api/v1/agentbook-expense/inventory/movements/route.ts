/** Movement ledger: GET ?itemId=&from=&to= (tenant-scoped, newest first, max 500). PR 5A. */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { movementView } from '@/lib/inventory';
import { inventoryErrorResponse, parseDate } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const sp = request.nextUrl.searchParams;
    const from = sp.get('from') ? parseDate(sp.get('from')) : null;
    const to = sp.get('to') ? parseDate(sp.get('to')) : null;
    const itemId = sp.get('itemId');
    const rows = await db.abStockMovement.findMany({
      where: {
        tenantId: r.tenantId,
        ...(itemId ? { itemId } : {}),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return NextResponse.json({ success: true, data: rows.map(movementView) });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/movements GET');
  }
}
