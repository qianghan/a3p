/**
 * Purchases listing (PR 3bc.7) — expenses and bills merged into one
 * date-sorted list. A bill is ONE row with a due/paid badge; paying it books
 * no expense, so nothing is shown twice (spec §5.2). Offset pagination, like
 * the legacy expense list: meta.total is the whole merged list.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { liveBillWhere } from '@/lib/bill-amounts';
import { liveExpenseWhere } from '@/lib/agentbook-live-expense';
import {
  PURCHASE_BILL_STATUSES, billDateOf, billToPurchase, expenseToPurchase, mergePurchases,
} from '@/lib/purchases-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function intParam(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : dflt;
}
function dateParam(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const p = request.nextUrl.searchParams;
    const limit = Math.max(1, intParam(p.get('limit'), DEFAULT_LIMIT, MAX_LIMIT));
    const offset = intParam(p.get('offset'), 0, 100_000);
    const start = dateParam(p.get('startDate'));
    const end = dateParam(p.get('endDate'));
    // kind=bill: bill rows only (the /app Docs list already pages its own expenses).
    const billsOnly = p.get('kind') === 'bill';
    const range = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : null;

    const [expenses, expenseTotal, bills] = await Promise.all([
      billsOnly ? Promise.resolve([]) : db.abExpense.findMany({
        where: { tenantId, ...liveExpenseWhere(), archivedAt: null, ...(range ? { date: range } : {}) },
        include: { vendor: { select: { name: true } } },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: offset + limit,
      }),
      billsOnly ? Promise.resolve(0) : db.abExpense.count({ where: { tenantId, ...liveExpenseWhere(), archivedAt: null, ...(range ? { date: range } : {}) } }),
      // Bills are few per tenant; billDate ?? createdAt cannot be ordered in SQL, so filter here.
      db.abBill.findMany({
        where: { tenantId, ...liveBillWhere(), status: { in: [...PURCHASE_BILL_STATUSES] } },
        take: 1000,
      }),
    ]);

    const now = new Date();
    const liveBills = bills.filter((b) => {
      const d = billDateOf(b);
      return (!start || d >= start) && (!end || d <= end);
    });
    const rows = mergePurchases(
      [...expenses.map(expenseToPurchase), ...liveBills.map((b) => billToPurchase(b, now))],
      limit,
      offset,
    );
    return NextResponse.json({
      success: true,
      data: rows,
      meta: { total: expenseTotal + liveBills.length, limit, offset },
    });
  } catch (err) {
    console.error('[agentbook-expense/purchases GET] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
