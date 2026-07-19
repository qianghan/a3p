/**
 * Pay-run preview — GET only, computes real per-employee withholding via
 * the same pure payroll engine the real POST /pay-runs route uses, but
 * never writes to the database. Used by the chat/MCP `run-payroll` skill
 * (PARITY-6) so it can show real withholding math instead of a rough
 * gross-only estimate, without side effects.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { calcPay, periodGross, PERIODS_PER_YEAR } from '@/lib/payroll-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const employees = await db.abEmployee.findMany({ where: { tenantId, isActive: true } });
    if (employees.length === 0) {
      return NextResponse.json({ success: false, error: 'no active employees to pay' }, { status: 400 });
    }

    const results = employees.map((emp) => {
      const periodsPerYear = PERIODS_PER_YEAR[emp.payFrequency] ?? 26;
      const grossCents = emp.payType === 'salary' ? periodGross(emp.payRateCents, emp.payFrequency) : emp.payRateCents;
      const pay = calcPay({
        jurisdiction: emp.jurisdiction,
        grossCents,
        payPeriodsPerYear: periodsPerYear,
        filingStatus: emp.filingStatus,
        region: emp.region,
      });
      return { employeeId: emp.id, name: emp.name, jurisdiction: emp.jurisdiction, ...pay };
    });

    const totalGrossCents = results.reduce((s, r) => s + r.grossCents, 0);
    const totalNetCents = results.reduce((s, r) => s + r.netCents, 0);
    const totalWithheldCents = totalGrossCents - totalNetCents;

    return NextResponse.json({
      success: true,
      data: { employees: results, totalGrossCents, totalNetCents, totalWithheldCents },
    });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs/preview] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
