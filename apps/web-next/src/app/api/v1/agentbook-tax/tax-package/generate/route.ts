/**
 * Year-end tax package — generate endpoint.
 *
 *   POST /api/v1/agentbook-tax/tax-package/generate
 *   body: { year: number, jurisdiction?: 'us' | 'ca' }
 *
 * Calls the orchestrator in `lib/agentbook-tax-package.ts`, which is
 * idempotent on `(tenantId, year, jurisdiction)`. A second call for
 * the same triple regenerates artifacts but reuses the row id, which
 * the e2e suite asserts.
 *
 * Tenant scoping happens up-front via `resolveAgentbookTenant`; every
 * downstream Prisma query in `gatherPackageData` filters by `tenantId`.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generatePackage } from '@/lib/agentbook-tax-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s ceiling matches Vercel's hobby-plan max function duration. The
// orchestrator must finish PDF + CSVs + receipts ZIP within this budget.
export const maxDuration = 60;

interface GenerateBody {
  year?: number | string;
  jurisdiction?: 'us' | 'ca';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as GenerateBody;

    // Validate year up front. Accept number or numeric string; reject
    // anything that isn't an integer in the calendar-year window. We
    // do not silently default — a missing year is a 400.
    const yearRaw = body.year;
    const year = typeof yearRaw === 'number' ? yearRaw : Number(yearRaw);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { success: false, error: 'year must be a 4-digit calendar year' },
        { status: 400 },
      );
    }

    // Resolve jurisdiction: explicit body wins, else read tenant config,
    // else default 'us'. This mirrors the mileage POST behaviour.
    let jurisdiction: 'us' | 'ca' = body.jurisdiction === 'ca' ? 'ca' : 'us';
    if (!body.jurisdiction) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    }

    const result = await generatePackage({ tenantId, year, jurisdiction });

    return NextResponse.json({
      success: true,
      data: {
        packageId: result.packageId,
        pdfUrl: result.pdfUrl,
        receiptsZipUrl: result.receiptsZipUrl ?? null,
        csvUrls: result.csvUrls,
        summary: result.summary,
      },
    });
  } catch (err) {
    // Server-side: log full error for ops. Client-side: return a
    // generic, stable message — the orchestrator already persisted a
    // categorised failure code on the package row so the UI can read
    // that for the per-row banner; we don't echo raw `err.message`
    // here because it could leak server internals.
    console.error('[agentbook-tax/tax-package/generate POST] failed:', err);
    return NextResponse.json(
      { success: false, error: 'Internal error', code: 'TAX_PACKAGE_FAILED' },
      { status: 500 },
    );
  }
}
