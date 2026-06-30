/** Payroll tax deposits — list upcoming/paid (GET) + mark one paid (POST). */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const deposits = await db.abPayrollTaxDeposit.findMany({
      where: { tenantId },
      orderBy: { dueDate: 'asc' },
    });
    return NextResponse.json({ success: true, data: deposits });
  } catch (err) {
    console.error('[agentbook-payroll/tax-deposits GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const dep = await db.abPayrollTaxDeposit.findFirst({ where: { id: body.id, tenantId } });
    if (!dep) return NextResponse.json({ success: false, error: 'deposit not found' }, { status: 404 });
    const updated = await db.abPayrollTaxDeposit.update({ where: { id: dep.id }, data: { status: 'paid', paidAt: new Date() } });
    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-payroll/tax-deposits POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
