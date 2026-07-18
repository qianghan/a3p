/**
 * GET /api/v1/agentbook-payroll/year-end/pdf?year=&employeeId= — serve a real
 * PDF for one employee's year-end form (W-2/T4/P60/Payment Summary), instead
 * of the JSON the year-end/ route serves for the whole list.
 *
 * Reuses the exact tenant-resolution + per-employee stub-aggregation shape
 * already established in year-end/route.ts (one employee at a time here,
 * instead of every employee with stubs that year).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { buildYearEndForm } from '@/lib/year-end-forms';
import { renderW2Pdf } from '@/lib/payroll-forms-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);
    const employeeId = request.nextUrl.searchParams.get('employeeId');
    if (!employeeId) {
      return NextResponse.json({ success: false, error: 'employeeId required' }, { status: 400 });
    }
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);

    const [cfg, employee] = await Promise.all([
      db.abTenantConfig.findUnique({ where: { userId: tenantId } }),
      db.abEmployee.findFirst({ where: { id: employeeId, tenantId } }),
    ]);
    if (!employee) {
      return NextResponse.json({ success: false, error: 'employee not found' }, { status: 404 });
    }
    const jurisdiction = cfg?.jurisdiction || 'us';

    const stubs = await db.abPayStub.findMany({
      where: {
        tenantId,
        employeeId,
        payRun: { periodEnd: { gte: yearStart, lt: yearEnd }, status: 'paid' },
      },
    });
    if (stubs.length === 0) {
      return NextResponse.json({ success: false, error: `no processed pay stubs for ${employee.name} in ${year}` }, { status: 404 });
    }

    const form = buildYearEndForm(employee.name, employee.jurisdiction || jurisdiction, year, stubs, employee.id);

    const pdf = await renderW2Pdf({
      employeeName: form.employeeName,
      employerName: cfg?.companyName || 'AgentBook',
      year: form.year,
      boxes: form.boxes,
      formType: form.formType,
    });

    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${form.formType.replace(/\s+/g, '-')}-${employee.name.replace(/\s+/g, '-')}-${year}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    console.error('[agentbook-payroll/year-end/pdf] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
