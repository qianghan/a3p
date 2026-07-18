/**
 * Pay runs — list (GET) + create (POST).
 *
 * Creating a pay run computes a pay stub for every active employee using the
 * pure payroll engine (gross for the period → federal/FICA withholding → net),
 * in a single transaction. The run starts in 'draft'; /process posts it to the
 * ledger.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { calcPay, periodGross, PERIODS_PER_YEAR } from '@/lib/payroll-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const runs = await db.abPayRun.findMany({
      where: { tenantId },
      orderBy: { periodEnd: 'desc' },
      include: { stubs: true },
      take: 50,
    });
    return NextResponse.json({ success: true, data: runs });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { periodStart?: string; periodEnd?: string };
    if (!body.periodStart || !body.periodEnd) {
      return NextResponse.json({ success: false, error: 'periodStart and periodEnd are required' }, { status: 400 });
    }
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      return NextResponse.json({ success: false, error: 'invalid dates' }, { status: 400 });
    }

    const employees = await db.abEmployee.findMany({ where: { tenantId, isActive: true } });
    if (employees.length === 0) {
      return NextResponse.json({ success: false, error: 'no active employees to pay' }, { status: 400 });
    }

    const run = await db.$transaction(async (tx) => {
      const created = await tx.abPayRun.create({
        data: { tenantId, periodStart, periodEnd, status: 'draft' },
      });
      for (const emp of employees) {
        const periodsPerYear = PERIODS_PER_YEAR[emp.payFrequency] ?? 26;
        // Salary → per-period split; hourly → rate treated as the period gross.
        const grossCents = emp.payType === 'salary' ? periodGross(emp.payRateCents, emp.payFrequency) : emp.payRateCents;
        const pay = calcPay({
          jurisdiction: emp.jurisdiction,
          grossCents,
          payPeriodsPerYear: periodsPerYear,
          filingStatus: emp.filingStatus,
          region: emp.region,
        });
        await tx.abPayStub.create({
          data: {
            tenantId,
            payRunId: created.id,
            employeeId: emp.id,
            employeeName: emp.name,
            grossCents: pay.grossCents,
            federalTaxCents: pay.federalTaxCents,
            stateTaxCents: pay.stateTaxCents,
            ficaCents: pay.ficaCents,
            otherDeductCents: pay.otherDeductCents,
            netCents: pay.netCents,
            sgCents: pay.sgCents,
          },
        });
      }
      return created;
    });

    const full = await db.abPayRun.findUnique({ where: { id: run.id }, include: { stubs: true } });
    return NextResponse.json({ success: true, data: full }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
