/**
 * Shared HTTP glue for the inventory routes: one error mapping, one body
 * parser. Every route is tenant-scoped via safeResolveAgentbookTenant and
 * returns { success, data } (cross-tenant ids are 404 — no FK on itemId).
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { isPublicError, publicErrorMessage } from '@/lib/api-error';
import { toUnits, unitsToDecimal, InventoryError } from '@/lib/inventory';

/** A coded refusal (InventoryError / PurchaseError, duck-typed across bundles) → its status; else 500. */
export function inventoryErrorResponse(err: unknown, where: string): NextResponse {
  const e = err as { status?: number; code?: string };
  if (isPublicError(err) && typeof e.status === 'number' && typeof e.code === 'string') {
    return NextResponse.json({ success: false, code: e.code, error: publicErrorMessage(err) }, { status: e.status });
  }
  // Duplicate SKU: @@unique([tenantId, sku]).
  if ((err as { code?: string })?.code === 'P2002') {
    return NextResponse.json({ success: false, code: 'duplicate_sku', error: 'An item with this SKU already exists' }, { status: 409 });
  }
  console.error(`[${where}] failed:`, err);
  return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
}

export function parseDate(v: unknown, fallback = new Date()): Date | null {
  if (v === undefined || v === null || v === '') return fallback;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

export interface ItemBody {
  sku?: string | null;
  name?: string;
  unit?: string;
  reorderPoint?: number | string | null;
  salePriceCents?: number | null;
  isActive?: boolean;
}

/** Validate + normalise the writable fields (shared with PATCH). */
export function itemData(body: ItemBody, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 200) throw new InventoryError(400, 'name_required');
    out.name = name;
  }
  if (body.sku !== undefined) {
    const sku = body.sku == null ? null : String(body.sku).trim().slice(0, 64) || null;
    out.sku = sku;
  }
  if (body.unit !== undefined) out.unit = String(body.unit || 'each').trim().slice(0, 32) || 'each';
  if (body.reorderPoint !== undefined) {
    if (body.reorderPoint === null || body.reorderPoint === '') out.reorderPoint = null;
    else {
      const u = toUnits(body.reorderPoint);
      if (u < 0) throw new InventoryError(400, 'invalid_reorder_point');
      out.reorderPoint = unitsToDecimal(u);
    }
  }
  if (body.salePriceCents !== undefined) {
    if (body.salePriceCents !== null && (!Number.isInteger(body.salePriceCents) || body.salePriceCents < 0)) throw new InventoryError(400, 'invalid_amount');
    out.salePriceCents = body.salePriceCents;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  return out;
}

