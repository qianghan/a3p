/**
 * Monthly deferred-revenue recognition.
 *
 * For every active AbDeferredRevenue schedule, recognize one month's slice
 * (total / periodMonths) once per calendar month. The final month recognizes
 * whatever remainder is left (so rounding never strands a few cents) and flips
 * the row to `completed`. Idempotent within a month via `lastRecognizedPeriod`.
 *
 * Auth: Vercel cron header or ?secret=CRON_SECRET (same pattern as the
 * billing crons). No ledger writes — this is a recognition overlay; reports
 * read recognizedAmountCents to split earned vs unearned revenue.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireCronSecret } from '@/lib/cron-auth';

// Auth: the shared fail-closed helper. This route used to authorise on
// `x-vercel-cron: 1` ALONE — an ordinary inbound header any caller can send —
// with the secret as a mere alternative. Since vercel.json's cron config
// carries no `?secret=`, that header was the only live auth path. The helper
// accepts the `Authorization: Bearer` Vercel attaches to a cron invocation.


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;


function currentMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const period = currentMonthKey();
  const active = await db.abDeferredRevenue.findMany({ where: { status: 'active' } });

  let recognized = 0;
  let completed = 0;

  for (const row of active) {
    // Skip schedules already recognized this month, or not yet started.
    if (row.lastRecognizedPeriod === period) continue;
    if (row.startDate > new Date()) continue;

    const remaining = row.totalAmountCents - row.recognizedAmountCents;
    const isFinalMonth = row.monthsRecognized + 1 >= row.periodMonths;
    // Floor the per-month slice; the final month takes the whole remainder so
    // rounding never strands cents or spills into an extra month.
    const perMonth = Math.floor(row.totalAmountCents / row.periodMonths);
    const slice = isFinalMonth ? remaining : Math.min(perMonth, remaining);
    const newRecognized = row.recognizedAmountCents + slice;
    const isComplete = isFinalMonth || newRecognized >= row.totalAmountCents;

    await db.abDeferredRevenue.update({
      where: { id: row.id },
      data: {
        recognizedAmountCents: isComplete ? row.totalAmountCents : newRecognized,
        monthsRecognized: row.monthsRecognized + 1,
        lastRecognizedPeriod: period,
        status: isComplete ? 'completed' : 'active',
      },
    });

    recognized++;
    if (isComplete) completed++;
  }

  return NextResponse.json({ success: true, data: { period, processed: active.length, recognized, completed } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
