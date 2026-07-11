/**
 * Housing affordability context — the cross-plugin play with the free
 * personal-finance layer. Reads the student's own income/spend (same source
 * as the Personal Finance snapshot) and returns a recommended max rent so
 * the Housing plugin can flag each saved listing as affordable or a stretch.
 * student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { computeSnapshot } from '@/lib/personal-snapshot';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Common rule of thumb: rent ≤ 30% of gross monthly income. Surfaced as
// guidance, not a hard rule — students often have irregular income.
const RENT_TO_INCOME = 0.3;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [accounts, monthTxns] = await Promise.all([
      db.abPersonalAccount.findMany({ where: { tenantId: guard.tenantId, archived: false } }),
      db.abPersonalTransaction.findMany({
        where: { tenantId: guard.tenantId, date: { gte: monthStart } },
        select: { amountCents: true, category: true, businessFlag: true },
      }),
    ]);
    const snap = computeSnapshot(accounts, monthTxns);
    const monthlyIncomeCents = snap.month.incomeCents;
    const hasIncome = monthlyIncomeCents > 0;
    return NextResponse.json({
      success: true,
      data: {
        hasIncome,
        monthlyIncomeCents,
        monthlySpendingCents: snap.month.spendingCents,
        recommendedMaxRentCents: hasIncome ? Math.round(monthlyIncomeCents * RENT_TO_INCOME) : null,
        rentToIncome: RENT_TO_INCOME,
      },
    });
  } catch (err) {
    console.error('[agentbook-housing/affordability] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
