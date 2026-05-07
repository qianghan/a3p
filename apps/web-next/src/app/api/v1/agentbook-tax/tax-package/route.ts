/**
 * Year-end tax package — list / get endpoint.
 *
 *   GET /api/v1/agentbook-tax/tax-package?year=2025  → list for the year
 *   GET /api/v1/agentbook-tax/tax-package?id=<uuid>  → fetch single row
 *   GET /api/v1/agentbook-tax/tax-package            → list all (newest first)
 *
 * Tenant-scoped: every query includes `tenantId` so a malicious caller
 * passing a known package id from another tenant gets a 404. Inputs are
 * format-validated up front (UUID for `id`, calendar-year bounds for
 * `year`) so a probe with a bogus value gets 400/404 — never 500 — and
 * can't be used to distinguish real rows from missing rows by error
 * shape.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const id = params.get('id');
    const yearParam = params.get('year');

    if (id) {
      // Validate the id shape up front. Treat malformed ids as 404 so
      // a tenant-probing request can't distinguish "row exists in
      // another tenant" from "row not found" via error shape.
      if (!UUID_RX.test(id)) {
        return NextResponse.json(
          { success: false, error: 'package not found' },
          { status: 404 },
        );
      }
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
      const y = Number(yearParam);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        return NextResponse.json(
          { success: false, error: 'year must be a 4-digit calendar year' },
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
    // Server-side: log full error for ops. Client-side: return a
    // generic message so we never leak server internals (file paths,
    // stack frames, env names) back to a probing caller.
    console.error('[agentbook-tax/tax-package GET] failed:', err);
    return NextResponse.json(
      { success: false, error: 'Internal error', code: 'TAX_PACKAGE_FAILED' },
      { status: 500 },
    );
  }
}
