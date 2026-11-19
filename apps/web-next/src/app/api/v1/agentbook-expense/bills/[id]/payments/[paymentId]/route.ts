/**
 * DELETE /bills/:id/payments/:paymentId — void one bill payment (PR 3bc).
 * Posts the mirror of the payment's entry (`bill_payment_void`, keyed by the
 * payment id) through lib/purchases and reopens the bill. A payment that is not
 * this tenant's, or not this bill's, is 404.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { voidPayment, PurchaseError } from '@/lib/purchases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx {
  params: Promise<{ id: string; paymentId: string }>;
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id, paymentId } = await ctx.params;
    const owned = await db.abBillPayment.findFirst({ where: { id: paymentId, billId: id, tenantId } });
    if (!owned) return NextResponse.json({ success: false, code: 'payment_not_found', error: 'payment not found' }, { status: 404 });
    const { bill, payment } = await voidPayment(db, tenantId, paymentId);
    return NextResponse.json({ success: true, data: bill, payment });
  } catch (err) {
    if (err instanceof PurchaseError) {
      return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
    }
    console.error('[agentbook-expense/bills void payment] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
