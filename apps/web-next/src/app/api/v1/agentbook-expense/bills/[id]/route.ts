/**
 * Bill detail operations — update (PUT), cancel (DELETE), pay (POST .../pay
 * is handled here via ?action=pay for a flat route surface).
 *
 * Pay posts the bill to the ledger at payment time: Dr <expense account>
 * / Cr Cash (1000), the same shape as a normal recorded expense. This makes
 * the expense land on both the cash and accrual P&L at the payment date and
 * never double-counts (bills carry no ledger impact before payment).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

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
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const existing = await db.abBill.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'bill not found' }, { status: 404 });
    const bill = await db.abBill.update({ where: { id }, data: { status: 'cancelled' } });
    return NextResponse.json({ success: true, data: bill });
  } catch (err) {
    console.error('[agentbook-expense/bills DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
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

    const bill = await db.abBill.findFirst({ where: { id, tenantId } });
    if (!bill) return NextResponse.json({ success: false, error: 'bill not found' }, { status: 404 });
    if (bill.status === 'paid') {
      return NextResponse.json({ success: false, error: 'bill already paid' }, { status: 409 });
    }
    if (bill.status === 'cancelled') {
      return NextResponse.json({ success: false, error: 'cannot pay a cancelled bill' }, { status: 409 });
    }

    const body = (await request.json().catch(() => ({}))) as { paidDate?: string };
    const paidDate = body.paidDate ? new Date(body.paidDate) : new Date();

    // Resolve the expense account to debit (bill's category, else first active expense account)
    // and the cash account to credit.
    const [expenseAccount, cashAccount] = await Promise.all([
      bill.categoryCode
        ? db.abAccount.findFirst({ where: { tenantId, code: bill.categoryCode } })
        : db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true }, orderBy: { code: 'asc' } }),
      db.abAccount.findFirst({ where: { tenantId, code: '1000' } }),
    ]);

    const updated = await db.$transaction(async (tx) => {
      let journalEntryId: string | null = null;
      if (expenseAccount && cashAccount) {
        const je = await tx.abJournalEntry.create({
          data: {
            tenantId,
            date: paidDate,
            memo: `Bill payment: ${bill.vendorName}`,
            sourceType: 'bill',
            verified: true,
            lines: {
              create: [
                { tenantId, accountId: expenseAccount.id, debitCents: bill.amountCents, creditCents: 0, description: bill.description || bill.vendorName },
                { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: bill.amountCents, description: `Payment: ${bill.vendorName}` },
              ],
            },
          },
        });
        journalEntryId = je.id;
      }

      return tx.abBill.update({
        where: { id },
        data: { status: 'paid', paidDate, journalEntryId },
      });
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/bills pay] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
