/** Opening stock for an item: DR 1500 | CR 3900 (stock_opening / item.id, one per item). PR 5A. */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { recordOpeningStock, movementView } from '@/lib/inventory';
import { inventoryErrorResponse, parseDate } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { qty?: number | string; valueCents?: number; date?: string };
    const date = parseDate(body.date);
    if (!date) return NextResponse.json({ success: false, code: 'invalid_date', error: 'invalid date' }, { status: 400 });
    const { movement, replayed } = await recordOpeningStock(db as never, r.tenantId, { itemId: id, qty: body.qty, valueCents: Number(body.valueCents), date });
    return NextResponse.json({ success: true, data: movementView(movement) }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items/:id/opening POST');
  }
}
