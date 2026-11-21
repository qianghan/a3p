/** Low-stock items (qty ≤ reorder point). Empty unless trackInventory is on. PR 5A. */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { lowStockItems } from '@/lib/inventory';
import { inventoryErrorResponse } from '@/lib/inventory-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const r = await safeResolveAgentbookTenant(request);
    if ('response' in r) return r.response;
    return NextResponse.json({ success: true, data: await lowStockItems(db, r.tenantId) });
  } catch (err) {
    return inventoryErrorResponse(err, 'inventory/low-stock GET');
  }
}
