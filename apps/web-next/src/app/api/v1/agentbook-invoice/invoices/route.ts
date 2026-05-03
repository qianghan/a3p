/**
 * Invoice list — native Next.js route.
 *
 * Read-only port of the legacy plugin Express handler. Detail and
 * mutating endpoints (POST, /:id, /:id/send, /:id/remind, payments,
 * recurring) still 501 via the generic [plugin]/[...path] proxy until
 * they are ported individually.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const status = params.get('status');
    const clientId = params.get('clientId');
    const startDate = params.get('startDate');
    const endDate = params.get('endDate');
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);

    const where: Record<string, unknown> = { tenantId };
    if (status) where.status = status;
    if (clientId) where.clientId = clientId;
    if (startDate || endDate) {
      const issuedDate: Record<string, Date> = {};
      if (startDate) issuedDate.gte = new Date(startDate);
      if (endDate) issuedDate.lte = new Date(endDate);
      where.issuedDate = issuedDate;
    }

    const [invoices, total] = await Promise.all([
      db.abInvoice.findMany({
        where,
        include: { lines: true, client: true },
        orderBy: { issuedDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.abInvoice.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: invoices,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    console.error('[agentbook-invoice/invoices GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
