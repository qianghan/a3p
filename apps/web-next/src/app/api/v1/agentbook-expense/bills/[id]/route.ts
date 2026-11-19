/**
 * Bill detail operations — read (GET), legacy edit (PUT), amend (PATCH),
 * cancel (DELETE), pay (POST .../pay
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
import { amendBill, liveBillWhere, payBill, voidBill, PurchaseError, type AmendInput } from '@/lib/purchases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** GET: one live (not soft-deleted) bill with its lines and payments. */
export async function GET(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const bill = await db.abBill.findFirst({ where: { id, tenantId, ...liveBillWhere() } });
    if (!bill) return NextResponse.json({ success: false, error: 'bill not found' }, { status: 404 });
    const [lines, payments] = await Promise.all([
      db.abBillLine.findMany({ where: { billId: id, tenantId } }),
      db.abBillPayment.findMany({ where: { billId: id, tenantId } }),
    ]);
    return NextResponse.json({ success: true, data: { ...bill, lines, payments } });
  } catch (err) {
    console.error('[agentbook-expense/bills GET :id] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
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

    const existing = await db.abBill.findFirst({ where: { id, tenantId, ...liveBillWhere() } });
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

/**
 * PATCH: amend a posted (at_entry, open, unpaid) bill through lib/purchases —
 * reverses the old entry and posts the new one. Amount/category/tax changes
 * rebuild the bill's single line; a multi-line bill must send `lines`.
 */
export async function PATCH(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      vendorName?: string; billNumber?: string | null; description?: string | null; billDate?: string; dueDate?: string;
      amountCents?: number; categoryCode?: string | null; taxCode?: string | null;
    };
    const input: AmendInput = {};
    if (body.vendorName !== undefined) input.vendorName = body.vendorName;
    if (body.billNumber !== undefined) input.billNumber = body.billNumber;
    if (body.description !== undefined) input.description = body.description;
    for (const k of ['billDate', 'dueDate'] as const) {
      if (body[k] === undefined) continue;
      const d = new Date(body[k] as string);
      if (isNaN(d.getTime())) return NextResponse.json({ success: false, error: `invalid ${k}` }, { status: 400 });
      input[k] = d;
    }
    if (body.amountCents !== undefined || body.categoryCode !== undefined || body.taxCode !== undefined) {
      if (body.amountCents !== undefined && (!Number.isInteger(body.amountCents) || body.amountCents <= 0)) {
        return NextResponse.json({ success: false, error: 'positive integer amountCents required' }, { status: 400 });
      }
      const bill = await db.abBill.findFirst({ where: { id, tenantId, ...liveBillWhere() } });
      if (!bill) return NextResponse.json({ success: false, error: 'bill not found' }, { status: 404 });
      const lines = await db.abBillLine.findMany({ where: { billId: id, tenantId } });
      if (lines.length > 1) {
        return NextResponse.json({ success: false, code: 'bill_multi_line', error: 'this bill has several lines; send lines' }, { status: 422 });
      }
      const line = lines[0];
      let categoryId: string | null = line?.categoryId ?? null;
      if (body.categoryCode !== undefined) {
        const cat = body.categoryCode
          ? await db.abAccount.findFirst({ where: { tenantId, code: body.categoryCode, accountType: 'expense' } })
          : null;
        if (body.categoryCode && !cat) {
          return NextResponse.json({ success: false, code: 'invalid_category', error: 'unknown categoryCode' }, { status: 422 });
        }
        categoryId = cat?.id ?? null;
      }
      input.lines = [{
        description: line?.description ?? bill.description ?? bill.vendorName,
        amountCents: body.amountCents ?? line?.amountCents ?? bill.amountCents,
        categoryId,
        taxCode: body.taxCode !== undefined ? body.taxCode : (line?.taxCode ?? null),
      }];
    }
    const { bill } = await amendBill(db, tenantId, id, input);
    return NextResponse.json({ success: true, data: bill });
  } catch (err) {
    const known = purchaseErrorResponse(err);
    if (known) return known;
    console.error('[agentbook-expense/bills PATCH] failed:', err);
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
    const { bill, payment } = await payBill(db, tenantId, id, {
      date: paidDate,
      amountCents: body.amountCents,
      method: body.method,
      idempotencyKey: body.idempotencyKey ?? request.headers.get('idempotency-key'),
    });
    return NextResponse.json({ success: true, data: bill, payment });
  } catch (err) {
    const known = purchaseErrorResponse(err);
    if (known) return known;
    console.error('[agentbook-expense/bills pay] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
