/** Payroll employees — list + create. */

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
    const employees = await db.abEmployee.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ success: true, data: employees });
  } catch (err) {
    console.error('[agentbook-payroll/employees GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateEmployeeBody {
  name?: string;
  email?: string;
  type?: string;
  payType?: string;
  payRateCents?: number;
  payFrequency?: string;
  jurisdiction?: string;
  filingStatus?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateEmployeeBody;

    if (!body.name || typeof body.payRateCents !== 'number' || body.payRateCents <= 0) {
      return NextResponse.json({ success: false, error: 'name and positive payRateCents are required' }, { status: 400 });
    }
    const employee = await db.abEmployee.create({
      data: {
        tenantId,
        name: body.name,
        email: body.email || null,
        type: body.type || 'w2',
        payType: body.payType || 'salary',
        payRateCents: body.payRateCents,
        payFrequency: body.payFrequency || 'biweekly',
        jurisdiction: body.jurisdiction || 'us',
        filingStatus: body.filingStatus || 'single',
      },
    });
    return NextResponse.json({ success: true, data: employee }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-payroll/employees POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
