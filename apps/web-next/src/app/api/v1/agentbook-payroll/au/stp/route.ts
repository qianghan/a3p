/**
 * GET /api/v1/agentbook-payroll/au/stp?payRunId=
 *
 * Prepares an STP Phase 2 pay-event for an AU pay run: aggregates every
 * employee's financial-year-to-date gross / PAYG-withholding / super from the
 * tenant's pay stubs (up to and including the target pay run) and returns the
 * ATO pay-event payload + employer totals.
 *
 * AU-only (422 otherwise). PREPARES ONLY — actual lodgment goes over SBR2 and
 * requires ATO software-provider accreditation (launch guide §7.1); this route
 * never transmits, and the event's `lodgment` stays 'prepared'.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { buildStpPayEvent, auFinancialYearOf, auFinancialYearStart } from '@agentbook/jurisdictions/au/stp-pay-event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if ((cfg?.jurisdiction || 'us') !== 'au') {
      return NextResponse.json(
        { success: false, error: { code: 'unsupported_jurisdiction', message: 'STP pay events are only available for Australian tenants.' } },
        { status: 422 },
      );
    }

    // Target pay run: the one requested, else the most recent by period end.
    const payRunId = request.nextUrl.searchParams.get('payRunId');
    const target = payRunId
      ? await db.abPayRun.findFirst({ where: { id: payRunId, tenantId } })
      : await db.abPayRun.findFirst({ where: { tenantId }, orderBy: { periodEnd: 'desc' } });
    if (!target) {
      return NextResponse.json({ success: false, error: { code: 'no_pay_run', message: 'No pay run found to report.' } }, { status: 404 });
    }

    const financialYear = auFinancialYearOf(target.periodEnd);
    const fyStart = auFinancialYearStart(financialYear);

    // Every pay run in the FY up to (and including) the target → YTD basis.
    const runs = await db.abPayRun.findMany({
      where: { tenantId, periodEnd: { gte: fyStart, lte: target.periodEnd } },
      include: { stubs: { select: { employeeId: true, employeeName: true, grossCents: true, federalTaxCents: true, sgCents: true } } },
    });

    // Aggregate YTD per employee. federalTaxCents = PAYG withholding, sgCents = super.
    const byEmp = new Map<string, { employeeId: string; name: string; ytdGrossCents: number; ytdPaygWithheldCents: number; ytdSuperCents: number }>();
    for (const run of runs) {
      for (const s of run.stubs) {
        const cur = byEmp.get(s.employeeId) ?? { employeeId: s.employeeId, name: s.employeeName, ytdGrossCents: 0, ytdPaygWithheldCents: 0, ytdSuperCents: 0 };
        cur.ytdGrossCents += s.grossCents;
        cur.ytdPaygWithheldCents += s.federalTaxCents;
        cur.ytdSuperCents += s.sgCents;
        cur.name = s.employeeName; // keep the latest name
        byEmp.set(s.employeeId, cur);
      }
    }

    const event = buildStpPayEvent({
      financialYear,
      periodStart: target.periodStart.toISOString().slice(0, 10),
      periodEnd: target.periodEnd.toISOString().slice(0, 10),
      payees: [...byEmp.values()],
    });

    return NextResponse.json({ success: true, data: { payRunId: target.id, ...event } });
  } catch (err) {
    console.error('[agentbook-payroll/au/stp] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
