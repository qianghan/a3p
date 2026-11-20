/**
 * One inventory item: GET (with its movement ledger), PATCH (edit fields),
 * DELETE (SOFT delete only — movements and journal history stay). PR 5A.
 * Quantity/value never change here; they move only through movements.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { itemView, loadItem, movementView } from '@/lib/inventory';
import { inventoryErrorResponse, itemData, type ItemBody } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { id } = await ctx.params;
    const item = await loadItem(db, r.tenantId, id);
    const movements = await db.abStockMovement.findMany({ where: { tenantId: r.tenantId, itemId: id }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 });
    return NextResponse.json({ success: true, data: { ...itemView(item), movements: movements.map(movementView) } });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items/:id GET');
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { id } = await ctx.params;
    await loadItem(db, r.tenantId, id);
    const data = itemData((await request.json().catch(() => ({}))) as ItemBody, true);
    if (data.sku) {
      const clash = await db.abInventoryItem.findFirst({ where: { tenantId: r.tenantId, sku: data.sku as string, NOT: { id } } });
      if (clash) return NextResponse.json({ success: false, code: 'duplicate_sku', error: 'An item with this SKU already exists' }, { status: 409 });
    }
    const item = await db.abInventoryItem.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: itemView(item) });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items/:id PATCH');
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { id } = await ctx.params;
    await loadItem(db, r.tenantId, id);
    const item = await db.abInventoryItem.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return NextResponse.json({ success: true, data: { id: item.id, deletedAt: item.deletedAt } });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items/:id DELETE');
  }
}
