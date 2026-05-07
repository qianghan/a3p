/**
 * Year-end tax package — list / get endpoint.
 *
 *   GET /api/v1/agentbook-tax/tax-package?year=2025  → list for the year
 *   GET /api/v1/agentbook-tax/tax-package?id=<uuid>  → fetch single row
 *   GET /api/v1/agentbook-tax/tax-package            → list all (newest first)
 *
 * Tenant-scoped: every query includes `tenantId` so a malicious caller
 * passing a known package id from another tenant gets a 404.
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
    const id = params.get('id');
    const yearParam = params.get('year');

    if (id) {
      const pkg = await db.abTaxPackage.findFirst({
        where: { id, tenantId },
      });
      if (!pkg) {
        return NextResponse.json(
          { success: false, error: 'package not found' },
          { status: 404 },
        );
      }
      return NextResponse.json({ success: true, data: pkg });
    }

    const where: { tenantId: string; year?: number } = { tenantId };
    if (yearParam) {
      const y = parseInt(yearParam, 10);
      if (!isFinite(y)) {
        return NextResponse.json(
          { success: false, error: 'year must be a number' },
          { status: 400 },
        );
      }
      where.year = y;
    }

    const rows = await db.abTaxPackage.findMany({
      where,
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
    });

    return NextResponse.json({ success: true, data: rows });
  } catch (err) {
    console.error('[agentbook-tax/tax-package GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
