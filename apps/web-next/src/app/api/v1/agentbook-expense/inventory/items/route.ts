/**
 * Inventory items — stock on hand (GET) and create (POST). PR 5A.
 * Creating items requires trackInventory (gate on the flag, not businessType).
 * Duplicate SKU per tenant → 409 duplicate_sku.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { assertInventoryEnabled, inventoryEnabled, itemView, stockOnHand } from '@/lib/inventory';
import { inventoryErrorResponse, itemData, type ItemBody } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const enabled = await inventoryEnabled(db, r.tenantId);
    const soh = await stockOnHand(db, r.tenantId);
    return NextResponse.json({ success: true, data: soh.items, summary: { totalValueCents: soh.totalValueCents, lowStockCount: soh.lowStockCount, trackInventory: enabled } });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items GET');
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    const { tenantId } = r;
    await assertInventoryEnabled(db, tenantId);
    const body = (await request.json().catch(() => ({}))) as ItemBody;
    const data = itemData(body, false);
    if (data.sku) {
      // Soft-deleted items keep their SKU (history), so the unique key still holds it.
      const clash = await db.abInventoryItem.findFirst({ where: { tenantId, sku: data.sku as string } });
      if (clash) return NextResponse.json({ success: false, code: 'duplicate_sku', error: 'An item with this SKU already exists' }, { status: 409 });
    }
    const item = await db.abInventoryItem.create({ data: { tenantId, unit: 'each', isActive: true, ...(data as { name: string }), onHandQty: '0', onHandValueCents: 0, deletedAt: null } });
    return NextResponse.json({ success: true, data: itemView(item) }, { status: 201 });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/items POST');
  }
}
