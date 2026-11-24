/**
 * Void an invoice — flip status, post a reversing journal entry,
 * decrement client totalBilledCents. Refuses if there are payments.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { InventoryError } from '@/lib/inventory';
import { voidInvoice } from '@/lib/invoice-void';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    return await voidInvoice(tenantId, id);
  } catch (err) {
    if (err instanceof InventoryError) {
      return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
    }
    console.error('[agentbook-invoice/invoices/:id/void] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
