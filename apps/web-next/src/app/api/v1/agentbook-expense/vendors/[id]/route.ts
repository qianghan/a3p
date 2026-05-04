/**
 * Expense vendor detail.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const vendor = await db.abVendor.findFirst({ where: { id, tenantId } });
    if (!vendor) {
      return NextResponse.json({ success: false, error: 'Vendor not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: vendor });
  } catch (err) {
    console.error('[agentbook-expense/vendors/:id] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
