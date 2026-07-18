/**
 * Year-end forms — one W-2 / T4 / P60 / Payment Summary payload per employee,
 * aggregated from their pay stubs in the requested year (?year=2026).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { buildYearEndForm } from '@/lib/year-end-forms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = cfg?.jurisdiction || 'us';

    const [employees, stubs] = await Promise.all([
      db.abEmployee.findMany({ where: { tenantId } }),
      db.abPayStub.findMany({
        where: { tenantId, payRun: { periodEnd: { gte: yearStart, lt: yearEnd }, status: 'paid' } },
      }),
    ]);

    const byEmployee = new Map<string, typeof stubs>();
    for (const s of stubs) {
      const arr = byEmployee.get(s.employeeId) ?? [];
      arr.push(s);
      byEmployee.set(s.employeeId, arr);
    }

    const forms = employees
      .map((e) => {
        const empStubs = byEmployee.get(e.id) ?? [];
        if (empStubs.length === 0) return null;
        return buildYearEndForm(e.name, e.jurisdiction || jurisdiction, year, empStubs, e.id, e.region || undefined);
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    return NextResponse.json({ success: true, data: { year, forms } });
  } catch (err) {
    console.error('[agentbook-payroll/year-end] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
