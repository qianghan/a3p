/**
 * Accounts-payable bills — list + create.
 *
 * GET: list bills (optional ?status=open|paid|overdue|cancelled|all). Open
 * bills past their due date are reported with effectiveStatus 'overdue'
 * (computed on read; the stored status stays 'open' until paid/cancelled).
 * Returns a roll-up of open + overdue totals.
 *
 * POST: create a bill (vendorName, amountCents, dueDate required). No ledger
 * impact yet — bills post to the ledger only when paid (see /bills/:id/pay).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { postBill, PurchaseError } from '@/lib/purchases';
import { isPurchasesAtEntryEnabled } from '@/lib/purchases-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface BillRow {
  id: string;
  status: string;
  dueDate: Date;
  amountCents: number;
}

function effectiveStatus(b: BillRow, now: Date): string {
  if (b.status === 'open' && b.dueDate < now) return 'overdue';
  return b.status;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const statusFilter = request.nextUrl.searchParams.get('status') || 'all';

    const rows = await db.abBill.findMany({
      where: { tenantId, ...(statusFilter !== 'all' && statusFilter !== 'overdue' ? { status: statusFilter } : {}) },
      orderBy: { dueDate: 'asc' },
    });

    const now = new Date();
    const withStatus = rows.map((b) => ({ ...b, effectiveStatus: effectiveStatus(b, now) }));
    const filtered = statusFilter === 'overdue'
      ? withStatus.filter((b) => b.effectiveStatus === 'overdue')
      : withStatus;

    const openCents = withStatus.filter((b) => b.status === 'open').reduce((s, b) => s + b.amountCents, 0);
    const overdueCents = withStatus.filter((b) => b.effectiveStatus === 'overdue').reduce((s, b) => s + b.amountCents, 0);

    return NextResponse.json({
      success: true,
      data: filtered,
      summary: { openCents, overdueCents, count: filtered.length },
    });
  } catch (err) {
    console.error('[agentbook-expense/bills GET] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

interface CreateBillBody {
  vendorName?: string;
  description?: string;
  amountCents?: number;
  categoryCode?: string;
  dueDate?: string;
  billDate?: string;
  billNumber?: string;
  currency?: string;
  taxCode?: string | null;
  idempotencyKey?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateBillBody;

    if (!body.vendorName || typeof body.amountCents !== 'number' || body.amountCents <= 0 || !body.dueDate) {
      return NextResponse.json(
        { success: false, error: 'vendorName, positive amountCents, and dueDate are required' },
        { status: 400 },
      );
    }
    const due = new Date(body.dueDate);
    if (isNaN(due.getTime())) {
      return NextResponse.json({ success: false, error: 'invalid dueDate' }, { status: 400 });
    }

    // O6: bills are booked in the tenant currency only (both posting modes).
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const tenantCurrency = String(cfg?.currency ?? 'USD').toUpperCase();
    if (body.currency && body.currency.toUpperCase() !== tenantCurrency) {
      return NextResponse.json(
        { success: false, code: 'bill_currency_unsupported', error: `Bills must be in ${tenantCurrency}` },
        { status: 422 },
      );
    }

    // PR 3bc: accrual tenants post AP at entry — behind `purchases_at_entry` (off).
    if (await isPurchasesAtEntryEnabled()) {
      if (cfg && cfg.accountingBasis !== 'cash') {
        // Omitted → the engine dates it today; a replay then ignores the date.
        const billDate = body.billDate ? new Date(body.billDate) : undefined;
        if (billDate && isNaN(billDate.getTime())) {
          return NextResponse.json({ success: false, error: 'invalid billDate' }, { status: 400 });
        }
        const category = body.categoryCode
          ? await db.abAccount.findFirst({ where: { tenantId, code: body.categoryCode, accountType: 'expense' } })
          : null;
        if (body.categoryCode && !category) {
          return NextResponse.json({ success: false, code: 'invalid_category', error: 'unknown categoryCode' }, { status: 422 });
        }
        try {
          const { bill, replayed } = await postBill(db, tenantId, {
            vendorName: body.vendorName, description: body.description ?? null, billNumber: body.billNumber ?? null,
            billDate, dueDate: due, currency: body.currency ?? null, postingMode: 'at_entry',
            idempotencyKey: body.idempotencyKey ?? request.headers.get('idempotency-key'),
            lines: [{ description: body.description || body.vendorName, amountCents: body.amountCents, categoryId: category?.id ?? null, taxCode: body.taxCode }],
          });
          return NextResponse.json({ success: true, data: bill }, { status: replayed ? 200 : 201 });
        } catch (err) {
          if (err instanceof PurchaseError) {
            return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
          }
          throw err;
        }
      }
    }

    const bill = await db.abBill.create({
      data: {
        tenantId,
        vendorName: body.vendorName,
        description: body.description || null,
        amountCents: body.amountCents,
        categoryCode: body.categoryCode || null,
        dueDate: due,
        status: 'open',
      },
    });

    return NextResponse.json({ success: true, data: bill }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-expense/bills POST] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
