/**
 * Stock adjustment (stock_adjust): negative qty relieves at average cost to
 * shrinkage 5995; positive qty needs valueCents. Idempotency-Key header or
 * body.idempotencyKey makes a retry replay instead of double-adjusting. PR 5A.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { adjustStock, movementView } from '@/lib/inventory';
import { inventoryErrorResponse, parseDate } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { qty?: number | string; valueCents?: number | null; date?: string; reason?: string; idempotencyKey?: string };
    const date = parseDate(body.date);
    if (!date) return NextResponse.json({ success: false, code: 'invalid_date', error: 'invalid date' }, { status: 400 });
    const { movement, replayed } = await adjustStock(db as never, r.tenantId, {
      itemId: id, qty: body.qty, valueCents: body.valueCents ?? null, date, reason: body.reason ?? null,
      idempotencyKey: body.idempotencyKey ?? request.headers.get('idempotency-key'),
    });
    return NextResponse.json({ success: true, data: movementView(movement) }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items/:id/adjust POST');
  }
}
