/**
 * Bill detail operations — update (PUT), cancel (DELETE), pay (POST .../pay
 * is handled here via ?action=pay for a flat route surface).
 *
 * Pay and cancel go through lib/purchases (PR 3bc). For legacy
 * `postingMode='at_payment'` bills pay still posts Dr <expense> / Cr Cash
 * (1000) at payment, now via the ledger writer: keyed 'bill' / payment.id,
 * period-gated, a missing category books 6999, and a missing account FAILS
 * the request instead of marking the bill paid with no entry. `at_entry`
 * bills pay Dr 2000 / Cr 1000. DELETE of a paid/partial bill is refused
 * until its payments are voided.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { payBill, voidBill, PurchaseError } from '@/lib/purchases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      vendorName?: string; description?: string | null; amountCents?: number; categoryCode?: string | null; dueDate?: string;
    };

    const existing = await db.abBill.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'bill not found' }, { status: 404 });
    if (existing.status === 'paid') {
      return NextResponse.json({ success: false, error: 'cannot edit a paid bill' }, { status: 409 });
    }
    if (existing.postingMode === 'at_entry') {
      // Its entry is already in the ledger: a raw field edit would drift from it.
      return NextResponse.json({ success: false, code: 'bill_amend_required', error: 'this bill is posted; amend it instead' }, { status: 409 });
    }

    const update: Record<string, unknown> = {};
    if (body.vendorName !== undefined) update.vendorName = body.vendorName;
    if (body.description !== undefined) update.description = body.description;
    if (body.amountCents !== undefined) update.amountCents = body.amountCents;
    if (body.categoryCode !== undefined) update.categoryCode = body.categoryCode;
    if (body.dueDate !== undefined) {
      const d = new Date(body.dueDate);
      if (isNaN(d.getTime())) return NextResponse.json({ success: false, error: 'invalid dueDate' }, { status: 400 });
      update.dueDate = d;
    }

    const bill = await db.abBill.update({ where: { id }, data: update });
    return NextResponse.json({ success: true, data: bill });
  } catch (err) {
    console.error('[agentbook-expense/bills PUT] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

function purchaseErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof PurchaseError) {
    return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
  }
  return null;
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const { bill } = await voidBill(db, tenantId, id);
    return NextResponse.json({ success: true, data: bill });
  } catch (err) {
    const known = purchaseErrorResponse(err);
    if (known) return known;
    console.error('[agentbook-expense/bills DELETE] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

// POST handles the "pay" action (?action=pay).
export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const action = request.nextUrl.searchParams.get('action');
    if (action !== 'pay') {
      return NextResponse.json({ success: false, error: 'unsupported action' }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      paidDate?: string; amountCents?: number; method?: string; idempotencyKey?: string;
    };
    // Omitted → the engine uses now; a keyed replay then ignores the date.
    const paidDate = body.paidDate ? new Date(body.paidDate) : undefined;
    if (paidDate && isNaN(paidDate.getTime())) {
      return NextResponse.json({ success: false, error: 'invalid paidDate' }, { status: 400 });
    }
    const { bill } = await payBill(db, tenantId, id, {
      date: paidDate,
      amountCents: body.amountCents,
      method: body.method,
      idempotencyKey: body.idempotencyKey ?? request.headers.get('idempotency-key'),
    });
    return NextResponse.json({ success: true, data: bill });
  } catch (err) {
    const known = purchaseErrorResponse(err);
    if (known) return known;
    console.error('[agentbook-expense/bills pay] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
