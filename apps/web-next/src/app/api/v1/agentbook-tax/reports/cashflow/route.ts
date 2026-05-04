/**
 * Monthly cash inflow/outflow report from journal lines on the cash
 * account (code 1000).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function parseDate(val: string | null, fallback: Date): Date {
  if (!val) return fallback;
  const d = new Date(val);
  return isNaN(d.getTime()) ? fallback : d;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const startDate = parseDate(params.get('startDate'), yearStart);
    const endDate = parseDate(params.get('endDate'), new Date());

    const cashAccount = await db.abAccount.findUnique({
      where: { tenantId_code: { tenantId, code: '1000' } },
    });
    if (!cashAccount) {
      return NextResponse.json({
        success: true,
        data: { months: [], message: 'No cash account (code 1000) found.' },
      });
    }

    const cashLines = await db.abJournalLine.findMany({
      where: { accountId: cashAccount.id, entry: { tenantId, date: { gte: startDate, lte: endDate } } },
      include: { entry: { select: { date: true } } },
    });

    const monthlyMap = new Map<string, { inCents: number; outCents: number }>();
    for (const line of cashLines) {
      const d = line.entry.date;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const bucket = monthlyMap.get(key) || { inCents: 0, outCents: 0 };
      bucket.inCents += line.debitCents;
      bucket.outCents += line.creditCents;
      monthlyMap.set(key, bucket);
    }

    const months = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        inCents: data.inCents,
        outCents: data.outCents,
        netCents: data.inCents - data.outCents,
      }));

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'report.cashflow.generated',
        actor: 'agent',
        action: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          monthCount: months.length,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        months,
        totalInCents: months.reduce((s, m) => s + m.inCents, 0),
        totalOutCents: months.reduce((s, m) => s + m.outCents, 0),
        totalNetCents: months.reduce((s, m) => s + m.netCents, 0),
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/reports/cashflow] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
